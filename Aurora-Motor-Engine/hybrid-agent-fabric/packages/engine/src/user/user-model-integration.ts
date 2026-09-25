import type { CapabilityLifecycleEvent } from "../capabilities/capability-broker.js";
import type { EventBus } from "../aurora/event-bus.js";
import type { UserModelService } from "./user-model-service.js";

/**
 * J1 (P1.44) event wiring: what actually happens in the engine flows into the
 * user model — task outcomes become signals and advice observations, research
 * and push capabilities become behavioural signals, and conversation goals
 * become *proposed* claims only while the user has consented to inference.
 *
 * Everything here is gated by per-feature consent (P1.48). With inference off
 * (the default) no claim is ever created automatically; with signals off no
 * telemetry is recorded. Handlers are fail-open: the wiring must never be able
 * to fail the task it observes.
 */

export interface UserModelIntegrationOptions {
  /** Fallback user for events that carry no userId (capability finishes). */
  defaultUserId?: string;
  /** Session-to-user binding consulted before the default. */
  resolveUser?: (sessionId: string) => string | undefined;
}

const GOAL_CLAIM_KEY = "current-focus";

export class UserModelIntegration {
  private readonly subscriptionIds: string[] = [];
  private brokerUnsubscribe: (() => void) | undefined;
  private readonly defaultUserId: string | undefined;
  private readonly resolveUser: ((sessionId: string) => string | undefined) | undefined;

  constructor(
    private readonly eventBus: EventBus,
    private readonly userModel: UserModelService,
    private readonly broker?: { subscribe(listener: (event: CapabilityLifecycleEvent) => void): () => void },
    options: UserModelIntegrationOptions = {},
  ) {
    this.defaultUserId = options.defaultUserId;
    this.resolveUser = options.resolveUser;
  }

  init(): void {
    this.subscriptionIds.push(
      this.eventBus.subscribe("task.received", async (event) => {
        await this.guard(async () => await this.onTaskReceived(String(event.payload["tenantId"] ?? "local"), event.payload));
      }),
      this.eventBus.subscribe("task.completed", async (event) => {
        await this.guard(async () => await this.onTaskCompleted(String(event.payload["tenantId"] ?? "local"), event.payload));
      }),
      this.eventBus.subscribe("task.failed", async (event) => {
        await this.guard(async () => await this.onTaskFailed(String(event.payload["tenantId"] ?? "local"), event.payload));
      }),
    );
    this.brokerUnsubscribe = this.broker?.subscribe((event) => {
      if (event.phase !== "finished" || event.status !== "ok") return;
      void this.guard(async () => await this.onCapabilityFinished(event));
    });
  }

  dispose(): void {
    for (const id of this.subscriptionIds) this.eventBus.unsubscribe(id);
    this.subscriptionIds.length = 0;
    this.brokerUnsubscribe?.();
    this.brokerUnsubscribe = undefined;
  }

  /** Conversation → goal claim, only while inference is consented. */
  async onTaskReceived(tenantId: string, payload: Record<string, unknown>): Promise<void> {
    const userId = this.userOf(payload);
    if (!userId) return;
    const goal = typeof payload["goal"] === "string" ? payload["goal"] : "";
    if (!goal) return;
    const consents = await this.userModel.featureConsents(tenantId, userId);
    if (!consents.features["inference"]) return;
    await this.userModel.observeClaim({
      tenantId,
      userId,
      category: "goal",
      key: GOAL_CLAIM_KEY,
      value: goal.slice(0, 500),
      confidence: 0.4,
      source: "inferred",
      evidenceRefs: typeof payload["taskId"] === "string" ? [payload["taskId"]] : [],
    });
  }

  /** Task outcome → activity signal + advice-followed observation. */
  async onTaskCompleted(tenantId: string, payload: Record<string, unknown>): Promise<void> {
    const userId = this.userOf(payload);
    if (!userId) return;
    const consents = await this.userModel.featureConsents(tenantId, userId);
    if (consents.features["signals"]) {
      await this.userModel.recordSignal({ tenantId, userId, kind: "activity", intensity: 0.6, note: "task completed" });
    }
    if (consents.features["advice-tracking"]) {
      const taskId = typeof payload["taskId"] === "string" ? payload["taskId"] : undefined;
      if (taskId) await this.userModel.observeAdviceFollowedByTask(tenantId, userId, taskId);
    }
  }

  /** Task failure → error signal (frustration detection input). */
  async onTaskFailed(tenantId: string, payload: Record<string, unknown>): Promise<void> {
    const userId = this.userOf(payload);
    if (!userId) return;
    const consents = await this.userModel.featureConsents(tenantId, userId);
    if (!consents.features["signals"]) return;
    await this.userModel.recordSignal({ tenantId, userId, kind: "error", intensity: 0.5, note: "task failed" });
  }

  /** Research/push capability finishes → behavioural signals. */
  async onCapabilityFinished(event: CapabilityLifecycleEvent): Promise<void> {
    const tenantId = event.context.tenantId;
    const userId = this.resolveUser?.(event.context.sessionId) ?? this.defaultUserId;
    if (!userId) return;
    const consents = await this.userModel.featureConsents(tenantId, userId);
    if (!consents.features["signals"]) return;
    if (event.descriptor.id === "research.query" || event.descriptor.id === "research.watcher.run") {
      await this.userModel.recordSignal({ tenantId, userId, kind: "research", intensity: 0.5, note: event.descriptor.id });
    } else if (event.descriptor.id === "git.push") {
      await this.userModel.recordSignal({ tenantId, userId, kind: "commit", intensity: 0.7, note: "git.push" });
    }
  }

  private userOf(payload: Record<string, unknown>): string | undefined {
    if (typeof payload["userId"] === "string" && payload["userId"]) return payload["userId"];
    if (typeof payload["sessionId"] === "string") {
      const resolved = this.resolveUser?.(payload["sessionId"]);
      if (resolved) return resolved;
    }
    return this.defaultUserId;
  }

  private async guard(handler: () => Promise<void>): Promise<void> {
    try {
      await handler();
    } catch {
      // User-model wiring must never fail the task it observes.
    }
  }
}
