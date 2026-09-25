import type { CapabilityLifecycleEvent } from "../capabilities/capability-broker.js";
import type { EventBus } from "../aurora/event-bus.js";
import type { InitiativeSource, ProactiveInitiativeService } from "./proactive-initiative-service.js";

/**
 * P1.49 event intake bus: what actually happens in the engine flows into the
 * proactive layer as typed intake events — memory, world model, git, files,
 * research, environment, task outcomes, inbound notifications and schedule
 * fires. Each source is mapped, never guessed; anything not in the map does
 * not produce an event. Handlers are fail-open: intake must never be able to
 * fail the thing it observes.
 *
 * The durable side (processed flags, watcher cooldowns, dedup) lives in the
 * initiative service's store, so a restart re-reads the same state and simply
 * continues — offsets are "unprocessed intake rows", not in-memory counters.
 */
export class ProactiveIntakeBus {
  private readonly subscriptionIds: string[] = [];
  private brokerUnsubscribe: (() => void) | undefined;
  private readonly lastScheduleFire = new Map<string, string>();

  constructor(
    private readonly eventBus: EventBus,
    private readonly initiative: ProactiveInitiativeService,
    private readonly broker?: { subscribe(listener: (event: CapabilityLifecycleEvent) => void): () => void },
    private readonly options: {
      /** Recent schedule fires, pulled by the proactive tick (K3). Tenant comes from the job. */
      recentSchedules?: () => Promise<Array<{ id: string; tenantId?: string; label?: string; lastRunAt?: string }>>;
    } = {},
  ) {}

  init(): void {
    this.subscriptionIds.push(
      this.eventBus.subscribe("task.completed", async (event) => {
        await this.guard(() => this.intake(String(event.payload["tenantId"] ?? "local"), "tasks",
          `Task completed: ${this.textOf(event.payload["goal"]) ?? this.textOf(event.payload["taskId"]) ?? "unnamed task"}`,
          { taskId: this.textOf(event.payload["taskId"]) }));
      }),
      this.eventBus.subscribe("task.failed", async (event) => {
        await this.guard(() => this.intake(String(event.payload["tenantId"] ?? "local"), "tasks",
          `Task failed: ${this.textOf(event.payload["goal"]) ?? this.textOf(event.payload["taskId"]) ?? "unnamed task"}`,
          { taskId: this.textOf(event.payload["taskId"]) }));
      }),
    );
    this.brokerUnsubscribe = this.broker?.subscribe((event) => {
      if (event.phase !== "finished" || event.status !== "ok") return;
      const mapped = this.sourceForCapability(event.descriptor.id);
      if (!mapped) return;
      void this.guard(() => this.intake(event.context.tenantId, mapped.source, mapped.summary, { capability: event.descriptor.id }));
    });
  }

  dispose(): void {
    for (const id of this.subscriptionIds) this.eventBus.unsubscribe(id);
    this.subscriptionIds.length = 0;
    this.brokerUnsubscribe?.();
    this.brokerUnsubscribe = undefined;
  }

  /** Inbound channel message (P1.49 "notifications") — wired from the channel gateway. */
  async recordNotification(message: { tenantId: string; platform: string; text: string; userId?: string }): Promise<void> {
    await this.guard(() => this.intake(
      message.tenantId,
      "notification",
      `Inbound ${message.platform} message: ${message.text.slice(0, 200)}`,
      { platform: message.platform, ...(message.userId ? { userId: message.userId } : {}) },
    ));
  }

  /**
   * Schedule fires, pulled by the proactive tick: every job whose lastRunAt
   * changed since the last pull becomes one intake event. In-memory tracking
   * means a restart may re-report the most recent fire once; the initiative
   * layer's own dedup makes that harmless, and pretending to persist offsets
   * we do not have would be worse.
   */
  async ingestRecentSchedules(windowMs = 30 * 60_000): Promise<number> {
    const jobs = await this.options.recentSchedules?.() ?? [];
    let ingested = 0;
    for (const job of jobs) {
      const firedAt = job.lastRunAt;
      if (!firedAt) continue;
      if (this.lastScheduleFire.get(job.id) === firedAt) continue;
      this.lastScheduleFire.set(job.id, firedAt);
      await this.guard(async () => {
        await this.initiative.ingest({
          tenantId: job.tenantId ?? "local",
          source: "schedules",
          summary: `Scheduled job fired: ${job.label ?? job.id}`,
          occurredAt: firedAt,
          tags: ["schedule"],
          entityRefs: [job.id],
        });
      });
      ingested++;
    }
    void windowMs;
    return ingested;
  }

  private sourceForCapability(capabilityId: string): { source: InitiativeSource; summary: string } | undefined {
    if (capabilityId.startsWith("git.")) return { source: "git", summary: `Git capability executed: ${capabilityId}` };
    if (capabilityId === "filesystem.write" || capabilityId === "filesystem.write_binary" || capabilityId === "filesystem.patch") {
      return { source: "filesystem", summary: `Workspace file changed via ${capabilityId}` };
    }
    if (capabilityId === "research.query" || capabilityId === "research.watcher.run") {
      return { source: "research", summary: `Research activity: ${capabilityId}` };
    }
    if (capabilityId === "environment.probe") {
      return { source: "system", summary: "Environment probe ran" };
    }
    return undefined;
  }

  private async intake(tenantId: string, source: InitiativeSource, summary: string, payload: Record<string, unknown>): Promise<void> {
    if (!summary.trim()) return;
    await this.initiative.ingest({ tenantId, source, summary, payload, tags: [source] });
  }

  private textOf(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  private async guard(handler: () => Promise<void>): Promise<void> {
    try {
      await handler();
    } catch {
      // Intake must never fail the thing it observes.
    }
  }
}
