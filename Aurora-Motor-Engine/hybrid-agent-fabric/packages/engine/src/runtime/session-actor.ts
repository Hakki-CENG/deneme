import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  AgentInboxMessage,
  ImageContent,
  CapabilityContext,
  CommandEnvelope,
  CommandResult,
  EventEnvelope,
  JsonValue,
  ModelProvider,
  ModelUsage,
  SessionSnapshot,
  SessionStatus,
  ToolCallContent,
  GoalState,
  AutonomousState,
  TaskItem,
  TaskPriority,
  TaskStatus,
  PromptCacheHint,
} from "../types.js";
import type { PromptCachePlanRecord } from "../prompt-cache/prompt-cache-service.js";
import type { EventStore } from "../persistence/event-store.js";
import type { SnapshotStore } from "../persistence/snapshot-store.js";
import type { CapabilityBroker, CapabilityLifecycleEvent } from "../capabilities/capability-broker.js";
import { ContextManager, type FrozenSessionContext } from "../context/context-manager.js";
import { AsyncMutex } from "../util/async-mutex.js";
import { asJsonValue, safePreview } from "../util/json.js";
import { evaluateContinuation } from "./continuation-policy.js";
import { SessionNotRunnableError } from "./session-errors.js";
import { SessionTree } from "./session-tree.js";

const ZERO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

export interface SessionDispatchHooks {
  onPromptAccepted?: (messageId: string, acceptedAt: string) => Promise<void> | void;
}

export interface SessionActorOptions {
  snapshot: SessionSnapshot;
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  model: ModelProvider;
  capabilities: CapabilityBroker;
  context: ContextManager;
  frozenContext: FrozenSessionContext;
  maxToolIterations?: number;
  /** Per-session effort resolution: the tool-iteration ceiling and the reasoning effort to request. */
  resolveEffort?: (tenantId: string, sessionId: string) => Promise<{ toolIterations: number; reasoningEffort: "low" | "medium" | "high" | "max" }>;
  /**
   * Optional prompt-cache planner: computes the breakpoint plan for the
   * assembled system prompt and messages and records it as durable evidence.
   */
  resolvePromptCache?: (input: { tenantId: string; sessionId: string; systemPrompt: string; messages: AgentMessage[] }) => Promise<{ plan: PromptCachePlanRecord; hint?: PromptCacheHint | undefined } | undefined>;
  modelName?: string;
  modelFallbacks?: string[];
  claimSteeringMessages?: (sessionId: string) => Promise<AgentInboxMessage[]>;
  markInboxDelivered?: (message: AgentInboxMessage, deliveredAt: string) => Promise<void>;
  markInboxUncertain?: (message: AgentInboxMessage, reason: string) => Promise<void>;
  onClose?: (sessionId: string) => Promise<void>;
}

export class SessionActor {
  private snapshot: SessionSnapshot;
  private readonly mutex = new AsyncMutex();
  private activeAbort: AbortController | undefined;
  private readonly maxToolIterations: number;
  private readonly tree: SessionTree;

  constructor(private readonly options: SessionActorOptions) {
    this.snapshot = structuredClone(options.snapshot);
    this.tree = new SessionTree(this.snapshot.tree, this.snapshot.messages);
    this.snapshot.tree = this.tree.state;
    this.snapshot.messages = this.tree.activeMessages();
    this.maxToolIterations = options.maxToolIterations ?? 12;
  }

  get state(): SessionSnapshot {
    return structuredClone(this.snapshot);
  }

  async initialize(recovered = false): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.emit(
        recovered ? "session.recovered" : "session.created",
        {
          name: this.snapshot.name,
          workspacePath: this.snapshot.workspacePath,
          parentSessionId: this.snapshot.parentSessionId ?? null,
          forkedFrom: asJsonValue(this.snapshot.forkedFrom ?? null),
          generation: this.snapshot.generation,
        },
        "user",
        "metadata-only",
      );
      if (recovered) await this.setStatus("idle", "recovery_completed");
      else await this.setStatus("idle", "initialization_completed");
      await this.persistSnapshot();
    });
  }

  private async applyChildLink(childSessionId: string): Promise<void> {
    if (this.snapshot.childSessionIds.includes(childSessionId)) return;
    this.snapshot.childSessionIds.push(childSessionId);
    await this.emit("subagent.linked", { childSessionId }, "user", "metadata-only");
    await this.persistSnapshot();
  }

  async linkChild(childSessionId: string): Promise<void> {
    await this.mutex.runExclusive(async () => await this.applyChildLink(childSessionId));
  }

  /** Called only by agent.spawn while this actor already owns its turn mutex. */
  async linkChildFromCapability(childSessionId: string): Promise<void> {
    await this.applyChildLink(childSessionId);
  }

  async recordFork(forkSessionId: string, messageId?: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.emit(
        "session.fork.created",
        { forkSessionId, messageId: messageId ?? null },
        "user",
        "metadata-only",
      );
      await this.persistSnapshot();
    });
  }

  get goal(): GoalState | undefined {
    return this.snapshot.goal ? structuredClone(this.snapshot.goal) : undefined;
  }

  get autonomous(): AutonomousState | undefined {
    return this.snapshot.autonomous ? structuredClone(this.snapshot.autonomous) : undefined;
  }

  /** Called from an in-turn goal capability; intentionally does not reacquire the actor mutex. */
  async goalActionFromCapability(action: string, payload: Record<string, JsonValue>, turnId: string): Promise<JsonValue> {
    const result = await this.applyGoalAction(action, payload, turnId);
    await this.persistSnapshot();
    return result;
  }

  /** Called from an in-turn task capability; intentionally does not reacquire the actor mutex. */
  async taskActionFromCapability(action: string, payload: Record<string, JsonValue>, turnId: string): Promise<JsonValue> {
    const result = await this.applyTaskAction(action, payload, turnId);
    await this.persistSnapshot();
    return result;
  }

  async dispatch(command: CommandEnvelope, hooks: SessionDispatchHooks = {}): Promise<CommandResult> {
    if (command.kind === "session.cancel") {
      this.activeAbort?.abort();
      return { commandId: command.commandId, status: "completed", result: { cancelled: Boolean(this.activeAbort) } };
    }
    return await this.mutex.runExclusive(async () => {
      if (command.expectedGeneration !== undefined && command.expectedGeneration !== this.snapshot.generation) {
        return {
          commandId: command.commandId,
          status: "rejected",
          error: {
            code: "STALE_GENERATION",
            message: `Expected generation ${command.expectedGeneration}, current is ${this.snapshot.generation}.`,
            retryable: true,
          },
        };
      }
      try {
        let result: JsonValue;
        switch (command.kind) {
          case "session.prompt":
          case "artifact.interaction":
          case "agent.message": {
            const payload = command.payload as { text?: JsonValue; attachments?: JsonValue };
            if (typeof payload.text !== "string" || !payload.text.trim()) throw new Error("Prompt text is required.");
            const attachments = this.validateImageAttachments(payload.attachments);
            result = await this.runPrompt(payload.text, command, hooks, attachments, command.kind === "artifact.interaction");
            break;
          }
          case "session.pause":
            await this.setStatus("paused", "user_pause");
            result = { status: "paused" };
            break;
          case "session.resume":
            await this.setStatus("idle", "user_resume");
            result = { status: "idle" };
            break;
          case "session.compact":
            result = await this.compact();
            break;
          case "session.tree.get":
            result = { activeLeafId: this.tree.leafId ?? null, entries: asJsonValue(this.tree.view()) };
            break;
          case "session.tree.branch": {
            const payload = command.payload as Record<string, JsonValue>;
            const entryId = typeof payload.entryId === "string" ? payload.entryId : "";
            if (!entryId) throw new Error("Tree branch entryId is required.");
            this.snapshot.messages = this.tree.branch(entryId);
            this.snapshot.tree = this.tree.state;
            await this.emit("session.tree.branched", { entryId, messageCount: this.snapshot.messages.length }, "user", "metadata-only");
            result = { activeLeafId: entryId, messages: this.snapshot.messages.length };
            break;
          }
          case "session.tree.label": {
            const payload = command.payload as Record<string, JsonValue>;
            const entryId = typeof payload.entryId === "string" ? payload.entryId : "";
            const label = typeof payload.label === "string" ? payload.label : null;
            if (!entryId) throw new Error("Tree label entryId is required.");
            const entry = this.tree.label(entryId, label);
            this.snapshot.tree = this.tree.state;
            await this.emit("session.tree.labeled", { entryId, labels: entry.labels }, "user", "metadata-only");
            result = { entryId, labels: entry.labels };
            break;
          }
          case "goal.set":
          case "goal.pause":
          case "goal.resume":
          case "goal.complete":
          case "goal.clear":
            result = await this.applyGoalAction(command.kind.slice("goal.".length), command.payload as Record<string, JsonValue>);
            break;
          case "autonomous.configure":
            result = await this.configureAutonomous(command.payload as Record<string, JsonValue>);
            break;
          case "model.select": {
            const payload = command.payload as Record<string, JsonValue>;
            const modelName = typeof payload.model === "string" ? payload.model.trim() : "";
            if (!isModelRoute(modelName)) throw new Error("Model must use provider:model format.");
            const fallbackModels = Array.isArray(payload.fallbackModels)
              ? payload.fallbackModels.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean)
              : this.snapshot.modelFallbacks ?? this.options.modelFallbacks ?? [];
            if (fallbackModels.length > 8 || fallbackModels.some((route) => !isModelRoute(route))) {
              throw new Error("fallbackModels must contain at most 8 provider:model routes.");
            }
            this.snapshot.modelName = modelName;
            this.snapshot.modelFallbacks = [...new Set(fallbackModels.filter((route) => route !== modelName))];
            await this.emit("model.selected", { model: modelName, fallbackModels: this.snapshot.modelFallbacks }, "user", "metadata-only");
            result = { model: modelName, fallbackModels: this.snapshot.modelFallbacks };
            break;
          }
          case "task.list":
          case "task.create":
          case "task.update":
            result = await this.applyTaskAction(command.kind.slice("task.".length), command.payload as Record<string, JsonValue>);
            break;
          case "session.close":
            await this.setStatus("closed", "user_close");
            await this.options.onClose?.(this.snapshot.sessionId);
            result = { status: "closed" };
            break;
          default:
            throw new Error(`Unsupported command: ${command.kind}`);
        }
        await this.persistSnapshot();
        return { commandId: command.commandId, status: "completed", result };
      } catch (error) {
        const wasCancelled = this.activeAbort?.signal.aborted === true;
        delete this.snapshot.activeTurnId;
        this.activeAbort = undefined;
        await this.emit(wasCancelled ? "turn.cancelled" : "command.failed", {
          commandId: command.commandId,
          kind: command.kind,
          error: error instanceof Error ? error.message : String(error),
        }, "user", "metadata-only");
        if (this.snapshot.status !== "closed" && this.snapshot.status !== "paused") {
          await this.setStatus("idle", wasCancelled ? "turn_cancelled" : "command_failed");
        }
        await this.persistSnapshot();
        // A refusal caused by the session's own state is reported under its own
        // code with the state attached. Folding it into COMMAND_FAILED is what
        // made "you are posting to a finished session" indistinguishable from a
        // crash for every caller of `engine.command`.
        const notRunnable = error instanceof SessionNotRunnableError ? error : undefined;
        return {
          commandId: command.commandId,
          status: "rejected",
          error: {
            code: notRunnable ? "SESSION_NOT_RUNNABLE" : "COMMAND_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
            ...(notRunnable ? { sessionState: notRunnable.sessionStatus } : {}),
          },
        };
      }
    });
  }

  async recordCapabilityLifecycle(event: CapabilityLifecycleEvent): Promise<void> {
    if (event.context.sessionId !== this.snapshot.sessionId) return;
    if (event.phase === "approval") await this.setStatus("waiting_approval", "capability_approval");
    if (event.phase === "started" && this.snapshot.status === "waiting_approval") await this.setStatus("running", "approval_granted");
    await this.emit(
      `capability.${event.phase}`,
      {
        capabilityId: event.descriptor.id,
        toolCallId: event.context.toolCallId,
        risk: event.descriptor.risk,
        decision: event.decision?.decision ?? null,
        reasonCode: event.decision?.reasonCode ?? null,
        status: event.status ?? null,
        durationMs: event.durationMs ?? null,
        error: event.error ?? null,
      },
      event.phase === "policy" ? "audit" : "user",
      "metadata-only",
      event.context.turnId,
    );
  }

  private appendMessage(message: AgentMessage, options: { contextReset?: boolean } = {}): void {
    this.tree.append(message, options);
    this.snapshot.tree = this.tree.state;
    this.snapshot.messages = this.tree.activeMessages();
  }

  private syncTreeProjection(): void {
    this.snapshot.tree = this.tree.state;
    this.snapshot.messages = this.tree.activeMessages();
  }

  private async applyGoalAction(
    action: string,
    payload: Record<string, JsonValue>,
    turnId?: string,
  ): Promise<JsonValue> {
    const now = new Date().toISOString();
    if (action === "set") {
      const objective = typeof payload.objective === "string" ? payload.objective.trim() : "";
      if (!objective) throw new Error("Goal objective is required.");
      const tokenBudget = typeof payload.tokenBudget === "number" && payload.tokenBudget > 0
        ? Math.floor(payload.tokenBudget)
        : undefined;
      const maxContinuations = typeof payload.maxContinuations === "number" && payload.maxContinuations > 0
        ? Math.min(100, Math.floor(payload.maxContinuations))
        : 3;
      this.snapshot.goal = {
        objective,
        status: "active",
        ...(tokenBudget ? { tokenBudget } : {}),
        maxContinuations,
        tokensUsed: 0,
        continuationCount: 0,
        createdAt: now,
        updatedAt: now,
      };
    } else if (action === "clear") {
      delete this.snapshot.goal;
    } else {
      const goal = this.snapshot.goal;
      if (!goal) throw new Error("No persistent goal exists.");
      if (action === "pause") goal.status = "paused";
      else if (action === "resume") goal.status = "active";
      else if (action === "complete") {
        goal.status = "completed";
        goal.completedAt = now;
      } else throw new Error(`Unknown goal action: ${action}`);
      goal.updatedAt = now;
    }
    await this.emit(
      `goal.${action}`,
      { goal: asJsonValue(this.snapshot.goal ?? null) },
      "user",
      "metadata-only",
      turnId,
    );
    return { goal: asJsonValue(this.snapshot.goal ?? null) };
  }

  private async applyTaskAction(action: string, payload: Record<string, JsonValue>, turnId?: string): Promise<JsonValue> {
    const tasks = this.snapshot.tasks ??= [];
    if (action === "list") {
      const status = typeof payload.status === "string" && TASK_STATUSES.has(payload.status as TaskStatus)
        ? payload.status as TaskStatus
        : undefined;
      const selected = status ? tasks.filter((task) => task.status === status) : tasks;
      return { tasks: asJsonValue(sortTasks(selected)) };
    }

    const now = new Date().toISOString();
    let task: TaskItem;
    if (action === "create") {
      if (tasks.length >= 500) throw new Error("A session task board is limited to 500 tasks.");
      const title = typeof payload.title === "string" ? payload.title.trim() : "";
      if (!title || title.length > 300) throw new Error("Task title must contain 1 to 300 characters.");
      const description = typeof payload.description === "string" ? payload.description.trim() : "";
      if (description.length > 20_000) throw new Error("Task description exceeds 20,000 characters.");
      const priority = typeof payload.priority === "string" && TASK_PRIORITIES.has(payload.priority as TaskPriority)
        ? payload.priority as TaskPriority
        : "normal";
      const dependsOn = taskDependencies(payload.dependsOn, tasks);
      const requestedStatus = typeof payload.status === "string" && TASK_STATUSES.has(payload.status as TaskStatus)
        ? payload.status as TaskStatus
        : "backlog";
      const status = requiresFinishedDependencies(requestedStatus) && !dependenciesDone(dependsOn, tasks)
        ? "blocked"
        : requestedStatus;
      const assigneeSessionId = taskAssignee(payload.assigneeSessionId, this.snapshot);
      task = {
        id: randomUUID(),
        title,
        ...(description ? { description } : {}),
        status,
        priority,
        dependsOn,
        ...(assigneeSessionId ? { assigneeSessionId } : {}),
        createdAt: now,
        updatedAt: now,
        ...(status === "done" ? { completedAt: now } : {}),
      };
      tasks.push(task);
    } else if (action === "update") {
      const id = typeof payload.id === "string" ? payload.id : "";
      const existing = tasks.find((item) => item.id === id);
      if (!existing) throw new Error(`Task ${id || "(missing)"} does not exist.`);
      task = existing;
      if (payload.title !== undefined) {
        const title = typeof payload.title === "string" ? payload.title.trim() : "";
        if (!title || title.length > 300) throw new Error("Task title must contain 1 to 300 characters.");
        task.title = title;
      }
      if (payload.description !== undefined) {
        if (payload.description !== null && typeof payload.description !== "string") throw new Error("Task description must be a string or null.");
        const description = typeof payload.description === "string" ? payload.description.trim() : "";
        if (description.length > 20_000) throw new Error("Task description exceeds 20,000 characters.");
        if (description) task.description = description;
        else delete task.description;
      }
      if (payload.priority !== undefined) {
        if (typeof payload.priority !== "string" || !TASK_PRIORITIES.has(payload.priority as TaskPriority)) throw new Error("Invalid task priority.");
        task.priority = payload.priority as TaskPriority;
      }
      if (payload.dependsOn !== undefined) {
        const dependsOn = taskDependencies(payload.dependsOn, tasks, task.id);
        const previous = task.dependsOn;
        task.dependsOn = dependsOn;
        if (taskGraphHasCycle(tasks)) {
          task.dependsOn = previous;
          throw new Error("Task dependency update would create a cycle.");
        }
      }
      if (payload.assigneeSessionId !== undefined) {
        const assignee = taskAssignee(payload.assigneeSessionId, this.snapshot);
        if (assignee) task.assigneeSessionId = assignee;
        else delete task.assigneeSessionId;
      }
      if (payload.status !== undefined) {
        if (typeof payload.status !== "string" || !TASK_STATUSES.has(payload.status as TaskStatus)) throw new Error("Invalid task status.");
        const requested = payload.status as TaskStatus;
        task.status = requiresFinishedDependencies(requested) && !dependenciesDone(task.dependsOn, tasks)
          ? "blocked"
          : requested;
      } else if (requiresFinishedDependencies(task.status) && !dependenciesDone(task.dependsOn, tasks)) {
        task.status = "blocked";
      }
      task.updatedAt = now;
      if (task.status === "done") task.completedAt ??= now;
      else delete task.completedAt;
    } else {
      throw new Error(`Unknown task action: ${action}`);
    }

    const unblocked: string[] = [];
    for (const candidate of tasks) {
      if (candidate.status === "blocked" && candidate.dependsOn.length > 0 && dependenciesDone(candidate.dependsOn, tasks)) {
        candidate.status = "ready";
        candidate.updatedAt = now;
        unblocked.push(candidate.id);
      }
    }
    await this.emit(
      `task.${action}`,
      { task: asJsonValue(task), unblockedTaskIds: unblocked },
      "user",
      "metadata-only",
      turnId,
    );
    return { task: asJsonValue(task), unblockedTaskIds: unblocked, tasks: asJsonValue(sortTasks(tasks)) };
  }

  private async configureAutonomous(payload: Record<string, JsonValue>): Promise<JsonValue> {
    const enabled = payload.enabled === true;
    const previous = this.snapshot.autonomous;
    const positiveInt = (value: JsonValue | undefined, fallback: number, max: number) =>
      typeof value === "number" && value > 0 ? Math.min(max, Math.floor(value)) : fallback;
    const gates = Array.isArray(payload.gates)
      ? payload.gates.filter((gate): gate is string => typeof gate === "string" && gate.trim().length > 0).slice(0, 20)
      : previous?.gates ?? [];
    this.snapshot.autonomous = {
      enabled,
      maxContinuations: positiveInt(payload.maxContinuations, previous?.maxContinuations ?? 3, 100),
      maxTurns: positiveInt(payload.maxTurns, previous?.maxTurns ?? 12, 1000),
      maxTokens: positiveInt(payload.maxTokens, previous?.maxTokens ?? 80_000, 10_000_000),
      timeoutMs: positiveInt(payload.timeoutMs, previous?.timeoutMs ?? 30 * 60_000, 24 * 60 * 60_000),
      continuationPrompt: typeof payload.continuationPrompt === "string" && payload.continuationPrompt.trim()
        ? payload.continuationPrompt.trim()
        : previous?.continuationPrompt ?? "Continue autonomously. Make a safe assumption when needed and verify progress with evidence.",
      gates,
      gateTimeoutMs: positiveInt(payload.gateTimeoutMs, previous?.gateTimeoutMs ?? 5 * 60_000, 30 * 60_000),
      gateMaxRetries: positiveInt(payload.gateMaxRetries, previous?.gateMaxRetries ?? 3, 20),
      continuationsUsed: enabled && !previous?.enabled ? 0 : previous?.continuationsUsed ?? 0,
      turnsUsed: enabled && !previous?.enabled ? 0 : previous?.turnsUsed ?? 0,
      tokensUsed: enabled && !previous?.enabled ? 0 : previous?.tokensUsed ?? 0,
      ...(enabled ? { startedAt: previous?.enabled && previous.startedAt ? previous.startedAt : new Date().toISOString() } : {}),
      gateAttempts: enabled && !previous?.enabled ? {} : previous?.gateAttempts ?? {},
      ...(previous?.lastGateFingerprint ? { lastGateFingerprint: previous.lastGateFingerprint } : {}),
      ...(previous?.lastGateFailure ? { lastGateFailure: previous.lastGateFailure } : {}),
    };
    await this.emit("autonomous.configured", { autonomous: asJsonValue(this.snapshot.autonomous) }, "user", "metadata-only");
    return { autonomous: asJsonValue(this.snapshot.autonomous) };
  }

  private async appendSteeringMessages(turnId: string, traceId: string): Promise<number> {
    if (!this.options.claimSteeringMessages) return 0;
    const claimed = await this.options.claimSteeringMessages(this.snapshot.sessionId);
    if (claimed.length === 0) return 0;
    try {
      for (const pending of claimed) {
        const message: AgentMessage = {
          id: randomUUID(),
          role: "user",
          timestamp: new Date().toISOString(),
          source: "agent",
          content: [{
            type: "text",
            text: [
              "Agent-to-agent message received.",
              `From ${pending.relationship} agent ${JSON.stringify(pending.senderName)} (${pending.senderSessionId}):`,
              pending.text,
            ].join("\n"),
          }],
        };
        this.appendMessage(message);
        await this.emit("message.created", {
          message: message as unknown as JsonValue,
          agentInboxMessageId: pending.id,
          steering: true,
        }, "user", "user-content", turnId, traceId);
      }
      await this.persistSnapshot();
      const deliveredAt = new Date().toISOString();
      for (const pending of claimed) {
        await this.options.markInboxDelivered?.(pending, deliveredAt);
        await this.emit("agent.message.delivered", {
          messageId: pending.id,
          senderSessionId: pending.senderSessionId,
          relationship: pending.relationship,
          deliveryMode: pending.effectiveMode,
          steering: true,
        }, "audit", "metadata-only", turnId, traceId);
      }
      return claimed.length;
    } catch (error) {
      for (const pending of claimed) {
        await this.options.markInboxUncertain?.(
          pending,
          `steering_delivery_failed:${error instanceof Error ? error.name : "unknown"}`,
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  private availableCapabilities() {
    const all = this.options.capabilities.list();
    const allowed = this.snapshot.agentProfile?.allowedCapabilityIds;
    if (!allowed) return all;
    const allowlist = new Set(allowed);
    return all.filter((capability) => allowlist.has(capability.id));
  }

  private activeTaskContext(): string {
    const active = (this.snapshot.tasks ?? []).filter((task) => task.status !== "done" && task.status !== "cancelled");
    if (active.length === 0) return "";
    const lines = sortTasks(active).slice(0, 100).map((task) =>
      `- ${task.id} [${task.status}/${task.priority}] ${task.title}${task.dependsOn.length ? ` (depends on: ${task.dependsOn.join(", ")})` : ""}`,
    );
    return `<SESSION_TASK_BOARD>\n${lines.join("\n")}\n</SESSION_TASK_BOARD>`;
  }

  private validateImageAttachments(value: JsonValue | undefined): ImageContent[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 8) throw new Error("Prompt attachments must be an array of at most 8 images.");
    return value.map((raw): ImageContent => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Prompt image attachment is invalid.");
      const item = raw as Record<string, JsonValue>;
      const mimeType = item.mimeType;
      if (typeof item.path !== "string" || !item.path.trim() || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(mimeType))) {
        throw new Error("Prompt image attachment path/MIME is invalid.");
      }
      if (item.sha256 !== undefined && (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256))) throw new Error("Prompt image attachment SHA-256 is invalid.");
      return {
        type: "image",
        path: item.path,
        mimeType: mimeType as ImageContent["mimeType"],
        ...(typeof item.sha256 === "string" ? { sha256: item.sha256.toLowerCase() } : {}),
        ...(typeof item.alt === "string" ? { alt: item.alt.slice(0, 1000) } : {}),
      };
    });
  }

  private async runPrompt(text: string, command: CommandEnvelope, hooks: SessionDispatchHooks = {}, attachments: ImageContent[] = [], hidden = false): Promise<JsonValue> {
    if (this.snapshot.status === "paused" || this.snapshot.status === "closed") {
      throw new SessionNotRunnableError(this.snapshot.sessionId, this.snapshot.status);
    }
    const turnId = randomUUID();
    const traceId = randomUUID();
    this.snapshot.activeTurnId = turnId;
    this.activeAbort = new AbortController();
    await this.setStatus("running", "prompt_accepted", turnId, traceId);

    const userMessage: AgentMessage = {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text }, ...attachments],
      timestamp: new Date().toISOString(),
      source: command.source,
      ...(hidden ? { hidden: true } : {}),
    };
    this.appendMessage(userMessage);
    await this.emit("message.created", { message: userMessage as unknown as JsonValue }, hidden ? "internal" : "user", "user-content", turnId, traceId);
    await this.persistSnapshot();
    await hooks.onPromptAccepted?.(userMessage.id, userMessage.timestamp);

    let finalText = "";
    let finalAssistantTimestamp = userMessage.timestamp;
    let exhaustedToolIterations = true;
    // Effort is resolved once per turn: a mid-turn change must not move the ceiling under the loop.
    const effort = this.options.resolveEffort
      ? await this.options.resolveEffort(this.snapshot.tenantId, this.snapshot.sessionId).catch(() => undefined)
      : undefined;
    const toolIterationCeiling = effort?.toolIterations ?? this.maxToolIterations;
    for (let iteration = 0; iteration < toolIterationCeiling; iteration++) {
      this.activeAbort.signal.throwIfAborted();
      await this.appendSteeringMessages(turnId, traceId);
      const availableCapabilities = this.availableCapabilities();
      const context = await this.options.context.assemble(
        this.options.frozenContext,
        this.snapshot.messages,
        availableCapabilities,
      );
      const selectedModel = this.snapshot.modelName ?? this.options.modelName;
      const fallbackModels = this.snapshot.modelFallbacks ?? this.options.modelFallbacks ?? [];
      const taskContext = this.activeTaskContext();
      const systemPrompt = taskContext ? `${context.systemPrompt}\n\n${taskContext}` : context.systemPrompt;
      const cachePlan = this.options.resolvePromptCache
        ? await this.options.resolvePromptCache({
            tenantId: this.snapshot.tenantId,
            sessionId: this.snapshot.sessionId,
            systemPrompt,
            messages: context.messages,
          }).catch(() => undefined)
        : undefined;
      await this.emit("model.request.started", {
        iteration,
        model: selectedModel ?? "default",
        fallbackCount: fallbackModels.length,
        contextProjection: asJsonValue(context.projection),
        ...(cachePlan ? { promptCache: asJsonValue(cachePlan.plan) } : {}),
      }, "audit", "metadata-only", turnId, traceId);
      let textOutput = "";
      const toolCalls: ToolCallContent[] = [];
      let usage: ModelUsage | undefined;
      let stopReason = "end_turn";
      for await (const event of this.options.model.stream({
        tenantId: this.snapshot.tenantId,
        sessionId: this.snapshot.sessionId,
        turnId,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(fallbackModels.length ? { fallbackModels } : {}),
        systemPrompt,
        messages: context.messages,
        workspacePath: this.snapshot.workspacePath,
        tools: availableCapabilities,
        ...(effort ? { reasoningEffort: effort.reasoningEffort } : {}),
        ...(cachePlan?.hint ? { promptCache: cachePlan.hint } : {}),
        signal: this.activeAbort.signal,
      })) {
        if (event.type === "text_delta") {
          textOutput += event.delta;
          await this.emit("model.text.delta", { delta: event.delta }, hidden ? "internal" : "user", "model-content", turnId, traceId);
        } else if (event.type === "reasoning_delta") {
          await this.emit("model.reasoning.delta", { delta: event.delta }, "internal", "model-content", turnId, traceId);
        } else if (event.type === "tool_call") {
          toolCalls.push(event.call);
        } else if (event.type === "usage") {
          usage = event.usage;
          this.addUsage(event.usage);
        } else if (event.type === "route_selected") {
          await this.emit("model.route.selected", {
            provider: event.provider,
            model: event.model,
            attempt: event.attempt,
            fallback: event.fallback,
          }, "audit", "metadata-only", turnId, traceId);
        } else if (event.type === "route_failed") {
          await this.emit("model.route.failed", {
            provider: event.provider,
            model: event.model,
            attempt: event.attempt,
            code: event.code,
            retryable: event.retryable,
          }, "audit", "metadata-only", turnId, traceId);
        } else if (event.type === "done") stopReason = event.stopReason;
      }
      const assistantMessage: AgentMessage = {
        id: randomUUID(),
        role: "assistant",
        content: [
          ...(textOutput ? [{ type: "text" as const, text: textOutput }] : []),
          ...toolCalls,
        ],
        timestamp: new Date().toISOString(),
        ...(usage ? { usage } : {}),
        ...(hidden ? { hidden: true } : {}),
      };
      this.appendMessage(assistantMessage);
      finalAssistantTimestamp = assistantMessage.timestamp;
      await this.emit("message.created", { message: assistantMessage as unknown as JsonValue }, hidden ? "internal" : "user", "model-content", turnId, traceId);
      await this.emit("model.request.finished", { iteration, stopReason, toolCalls: toolCalls.length, usage: asJsonValue(usage ?? ZERO_USAGE) }, "audit", "metadata-only", turnId, traceId);
      if (this.snapshot.autonomous?.enabled) this.snapshot.autonomous.turnsUsed++;
      finalText += textOutput;

      if (toolCalls.length === 0) {
        const steered = await this.appendSteeringMessages(turnId, traceId);
        if (steered > 0) continue;
        const continuation = await evaluateContinuation({
          ...(this.snapshot.autonomous ? { autonomous: this.snapshot.autonomous } : {}),
          ...(this.snapshot.goal ? { goal: this.snapshot.goal } : {}),
          runGate: async (gateCommand, timeoutMs) => {
            const result = await this.options.capabilities.execute(
              "process.exec",
              { command: gateCommand, timeoutMs, maxOutputChars: 6000 },
              {
                tenantId: this.snapshot.tenantId,
                sessionId: this.snapshot.sessionId,
                familyId: this.snapshot.familyId,
                turnId,
                toolCallId: randomUUID(),
                source: command.source,
                workspacePath: this.snapshot.workspacePath,
                ...(this.activeAbort?.signal ? { signal: this.activeAbort.signal } : {}),
                idempotencyKey: `${command.commandId}:gate:${iteration}:${gateCommand}`,
              },
            ) as Record<string, JsonValue>;
            return {
              command: gateCommand,
              exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
              output: typeof result.stdout === "string" ? result.stdout.slice(0, 6000) : JSON.stringify(result).slice(0, 6000),
            };
          },
          workspaceFingerprint: async () => {
            const fingerprint = await this.options.capabilities.execute(
              "process.exec",
              {
                command: "(git status --porcelain=v1; git diff --no-ext-diff) 2>/dev/null | sha256sum | cut -d' ' -f1",
                timeoutMs: 10_000,
                maxOutputChars: 256,
              },
              {
                tenantId: this.snapshot.tenantId,
                sessionId: this.snapshot.sessionId,
                familyId: this.snapshot.familyId,
                turnId,
                toolCallId: randomUUID(),
                source: command.source,
                workspacePath: this.snapshot.workspacePath,
                ...(this.activeAbort?.signal ? { signal: this.activeAbort.signal } : {}),
                idempotencyKey: `${command.commandId}:fingerprint:${iteration}`,
              },
            ) as Record<string, JsonValue>;
            return typeof fingerprint.stdout === "string" ? fingerprint.stdout.trim() : "unknown";
          },
        });
        await this.emit(
          "continuation.evaluated",
          { reason: continuation.reason, continue: continuation.continue, limit: continuation.limit ?? null },
          "user",
          "metadata-only",
          turnId,
          traceId,
        );
        if (continuation.continue && continuation.prompt) {
          if (this.snapshot.autonomous?.enabled) this.snapshot.autonomous.continuationsUsed++;
          if (this.snapshot.goal?.status === "active") this.snapshot.goal.continuationCount++;
          const continuationMessage: AgentMessage = {
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text: continuation.prompt }],
            timestamp: new Date().toISOString(),
            source: "agent",
            ...(hidden ? { hidden: true } : {}),
          };
          this.appendMessage(continuationMessage);
          await this.emit(
            "message.created",
            { message: continuationMessage as unknown as JsonValue, synthetic: true },
            hidden ? "internal" : "user",
            "metadata-only",
            turnId,
            traceId,
          );
          continue;
        }
        exhaustedToolIterations = false;
        if (continuation.reason === "limit_reached") {
          await this.emit("continuation.limit_reached", { limit: continuation.limit ?? "unknown" }, "user", "metadata-only", turnId, traceId);
        }
        break;
      }
      for (const call of toolCalls) {
        const capabilityContext: CapabilityContext = {
          tenantId: this.snapshot.tenantId,
          sessionId: this.snapshot.sessionId,
          familyId: this.snapshot.familyId,
          turnId,
          toolCallId: call.id,
          source: command.source,
          workspacePath: this.snapshot.workspacePath,
          ...(this.snapshot.agentProfile?.allowedCapabilityIds
            ? { allowedCapabilityIds: [...this.snapshot.agentProfile.allowedCapabilityIds] }
            : {}),
          ...(this.snapshot.agentProfile?.id ? { agentProfileId: this.snapshot.agentProfile.id } : {}),
          signal: this.activeAbort.signal,
          idempotencyKey: `${command.commandId}:${call.id}`,
        };
        let result: JsonValue;
        let isError = false;
        try {
          if (!availableCapabilities.some((capability) => capability.id === call.name)) {
            throw new Error(`Capability ${call.name} is not available to this session's agent profile.`);
          }
          result = await this.options.capabilities.execute(call.name, call.arguments, capabilityContext);
        } catch (error) {
          isError = true;
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        const toolMessage: AgentMessage = {
          id: randomUUID(),
          role: "tool",
          content: [{ type: "tool_result", toolCallId: call.id, name: call.name, result, isError }],
          timestamp: new Date().toISOString(),
          ...(hidden ? { hidden: true } : {}),
        };
        this.appendMessage(toolMessage);
        await this.emit("message.created", { message: toolMessage as unknown as JsonValue }, hidden ? "internal" : "user", "tool-result-sanitized", turnId, traceId);
      }
    }

    if (exhaustedToolIterations) {
      await this.emit("guardrail.tool_loop_limit", { maxIterations: toolIterationCeiling, effort: effort ? effort.reasoningEffort : "default" }, "user", "metadata-only", turnId, traceId);
    }
    delete this.snapshot.activeTurnId;
    this.activeAbort = undefined;
    await this.setStatus("idle", "turn_completed", turnId, traceId);
    const externalMemory = hidden ? { status: "disabled" as const } : await this.options.context.syncExternalMemory({
      tenantId: this.snapshot.tenantId,
      sessionId: this.snapshot.sessionId,
      turnId,
      userMessage: text,
      assistantResponse: finalText,
      userTimestamp: userMessage.timestamp,
      assistantTimestamp: finalAssistantTimestamp,
    });
    await this.emit("memory.external.sync", {
      providerId: externalMemory.providerId ?? null,
      status: externalMemory.status,
    }, "audit", "metadata-only", turnId, traceId);
    return { turnId, finalText, usage: asJsonValue(this.snapshot.totalUsage) };
  }

  private async compact(): Promise<JsonValue> {
    await this.setStatus("compacting", "manual_compaction");
    if (this.snapshot.messages.length <= 12) {
      await this.setStatus("idle", "compaction_not_needed");
      return { compacted: false, messageCount: this.snapshot.messages.length };
    }
    const removed = this.snapshot.messages.slice(0, -12);
    const retained = this.snapshot.messages.slice(-12);
    const summaryLines = removed
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-20)
      .map((message) => {
        const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
        return `- ${message.role}: ${text.slice(0, 500)}`;
      });
    const summary: AgentMessage = {
      id: randomUUID(),
      role: "system",
      timestamp: new Date().toISOString(),
      content: [{ type: "text", text: `<COMPACTION_SUMMARY>\n${summaryLines.join("\n")}\n</COMPACTION_SUMMARY>` }],
    };
    this.appendMessage(summary, { contextReset: true });
    for (const message of retained) {
      this.appendMessage({
        ...structuredClone(message),
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      });
    }
    await this.emit("session.compacted", {
      removedMessages: removed.length,
      retainedMessages: retained.length,
      summaryMessageId: summary.id,
      contextReset: true,
    }, "user", "model-content");
    await this.setStatus("idle", "compaction_completed");
    return { compacted: true, removedMessages: removed.length, retainedMessages: retained.length };
  }

  private addUsage(usage: ModelUsage): void {
    const budgetTokens = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens;
    if (this.snapshot.goal?.status === "active") {
      this.snapshot.goal.tokensUsed += budgetTokens;
      this.snapshot.goal.updatedAt = new Date().toISOString();
    }
    if (this.snapshot.autonomous?.enabled) this.snapshot.autonomous.tokensUsed += budgetTokens;
    this.snapshot.totalUsage.inputTokens += usage.inputTokens;
    this.snapshot.totalUsage.outputTokens += usage.outputTokens;
    this.snapshot.totalUsage.cacheReadTokens += usage.cacheReadTokens;
    this.snapshot.totalUsage.cacheWriteTokens += usage.cacheWriteTokens;
    this.snapshot.totalUsage.costUsd = (this.snapshot.totalUsage.costUsd ?? 0) + (usage.costUsd ?? 0);
  }

  private async setStatus(status: SessionStatus, reason: string, turnId?: string, traceId?: string): Promise<void> {
    if (this.snapshot.status === status) return;
    const previous = this.snapshot.status;
    this.snapshot.status = status;
    this.snapshot.updatedAt = new Date().toISOString();
    await this.emit("session.status.changed", { previous, status, reason }, "user", "metadata-only", turnId, traceId);
  }

  private async emit(
    type: string,
    payload: JsonValue,
    visibility: EventEnvelope["visibility"],
    redactionClass: EventEnvelope["redactionClass"],
    turnId?: string,
    traceId: string = randomUUID(),
  ): Promise<void> {
    const event: EventEnvelope = {
      schemaVersion: 1,
      eventId: randomUUID(),
      tenantId: this.snapshot.tenantId,
      sessionId: this.snapshot.sessionId,
      familyId: this.snapshot.familyId,
      generation: this.snapshot.generation,
      sequence: ++this.snapshot.lastSequence,
      ...(turnId ? { turnId } : {}),
      traceId,
      type,
      timestamp: new Date().toISOString(),
      visibility,
      redactionClass,
      payload: safePreview(payload, 100_000),
    };
    await this.options.eventStore.append(event);
  }

  private async persistSnapshot(): Promise<void> {
    this.snapshot.updatedAt = new Date().toISOString();
    await this.options.snapshotStore.save(this.snapshot);
  }
}

const TASK_STATUSES = new Set<TaskStatus>(["backlog", "ready", "in_progress", "blocked", "review", "done", "cancelled"]);
const TASK_PRIORITIES = new Set<TaskPriority>(["low", "normal", "high", "critical"]);
const TASK_PRIORITY_ORDER: Record<TaskPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

function isModelRoute(value: string): boolean {
  const separator = value.indexOf(":");
  return separator > 0 && separator < value.length - 1 && /^[a-z0-9][a-z0-9-]*$/i.test(value.slice(0, separator)) && value.length <= 300;
}

function sortTasks(tasks: TaskItem[]): TaskItem[] {
  return [...tasks]
    .sort((left, right) => TASK_PRIORITY_ORDER[left.priority] - TASK_PRIORITY_ORDER[right.priority] || left.createdAt.localeCompare(right.createdAt))
    .map((task) => structuredClone(task));
}

function taskDependencies(value: JsonValue | undefined, tasks: TaskItem[], currentTaskId?: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== "string")) {
    throw new Error("dependsOn must be an array containing at most 50 task IDs.");
  }
  const dependencies = [...new Set(value as string[])];
  if (currentTaskId && dependencies.includes(currentTaskId)) throw new Error("A task cannot depend on itself.");
  for (const id of dependencies) if (!tasks.some((task) => task.id === id)) throw new Error(`Dependency task ${id} does not exist.`);
  return dependencies;
}

function taskGraphHasCycle(tasks: TaskItem[]): boolean {
  const marks = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    const mark = marks.get(id);
    if (mark === "visiting") return true;
    if (mark === "done") return false;
    marks.set(id, "visiting");
    const task = tasks.find((item) => item.id === id);
    for (const dependency of task?.dependsOn ?? []) if (visit(dependency)) return true;
    marks.set(id, "done");
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

function dependenciesDone(ids: string[], tasks: TaskItem[]): boolean {
  return ids.every((id) => tasks.find((task) => task.id === id)?.status === "done");
}

function requiresFinishedDependencies(status: TaskStatus): boolean {
  return status === "ready" || status === "in_progress" || status === "review" || status === "done";
}

function taskAssignee(value: JsonValue | undefined, snapshot: SessionSnapshot): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("assigneeSessionId must be a session ID or null.");
  const allowed = new Set([snapshot.sessionId, ...snapshot.childSessionIds]);
  if (!allowed.has(value)) throw new Error("A task can only be assigned to this session or one of its direct children.");
  return value;
}

export function createInitialSnapshot(input: {
  sessionId: string;
  familyId?: string;
  parentSessionId?: string;
  forkedFrom?: { sessionId: string; messageId?: string };
  tenantId: string;
  name: string;
  workspacePath: string;
  initialMessages?: AgentMessage[];
  modelFallbacks?: string[];
  agentProfile?: import("../types.js").SessionAgentProfile;
}): SessionSnapshot {
  const now = new Date().toISOString();
  return {
    sessionId: input.sessionId,
    familyId: input.familyId ?? input.sessionId,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
    tenantId: input.tenantId,
    generation: 1,
    lastSequence: 0,
    status: "ready",
    name: input.name,
    workspacePath: input.workspacePath,
    createdAt: now,
    updatedAt: now,
    messages: input.initialMessages ? structuredClone(input.initialMessages) : [],
    childSessionIds: [],
    ...(input.agentProfile?.modelRoute ? { modelName: input.agentProfile.modelRoute } : {}),
    ...((input.agentProfile?.fallbackModels.length ?? 0) > 0
      ? { modelFallbacks: [...input.agentProfile!.fallbackModels] }
      : input.modelFallbacks?.length ? { modelFallbacks: [...input.modelFallbacks] } : {}),
    ...(input.agentProfile ? { agentProfile: structuredClone(input.agentProfile) } : {}),
    tasks: [],
    totalUsage: structuredClone(ZERO_USAGE),
  };
}
