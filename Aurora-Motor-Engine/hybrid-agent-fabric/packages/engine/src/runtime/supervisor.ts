import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapabilityBroker } from "../capabilities/capability-broker.js";
import type { ContextManager } from "../context/context-manager.js";
import type { AgentMessage, ModelProvider, PromptCacheHint } from "../types.js";
import type { PromptCachePlanRecord } from "../prompt-cache/prompt-cache-service.js";
import type {
  AgentInboxMessage,
  AgentMessageDeliveryMode,
  AgentMessageReceipt,
  AgentMessageRelationship,
  CommandEnvelope,
  CommandResult,
  JsonValue,
  SessionAgentProfile,
  SessionSnapshot,
} from "../types.js";
import type { CommandJournalLike } from "../persistence/command-journal.js";
import type { EventStore } from "../persistence/event-store.js";
import type { SnapshotStore } from "../persistence/snapshot-store.js";
import { atomicWrite } from "../util/atomic-file.js";
import { SessionLeaseManager, type SessionLeaseManagerLike } from "../persistence/session-lease.js";
import { createInitialSnapshot, SessionActor, type SessionDispatchHooks } from "./session-actor.js";
export {
  SessionAlreadyExistsError,
  SessionLimitError,
  SessionNotFoundError,
  SessionNotRunnableError,
  type AgentFanoutLimits,
  type FanoutLimitKind,
} from "./session-errors.js";
import {
  SessionAlreadyExistsError,
  SessionLimitError,
  SessionNotFoundError,
  type AgentFanoutLimits,
  type FanoutLimitKind,
} from "./session-errors.js";
import { FileAgentInboxStore, newAgentInboxMessage, type AgentInboxStore } from "./agent-inbox.js";

const execFileAsync = promisify(execFile);

interface SessionCatalogRecord {
  sessionId: string;
  tenantId: string;
  familyId: string;
  parentSessionId?: string;
  forkedFrom?: { sessionId: string; messageId?: string };
  name: string;
  workspacePath: string;
  createdAt: string;
}

export interface CreateSessionInput {
  sessionId?: string;
  tenantId: string;
  name?: string;
  workspacePath?: string;
  familyId?: string;
  parentSessionId?: string;
  forkedFrom?: { sessionId: string; messageId?: string };
  initialMessages?: SessionSnapshot["messages"];
  agentProfile?: SessionAgentProfile;
  skipParentLink?: boolean;
}

export interface AgentDirectoryEntry {
  sessionId: string;
  name: string;
  familyId: string;
  status: SessionSnapshot["status"];
  busy: boolean;
  resident: boolean;
  depth: number;
  updatedAt: string;
  createdAt: string;
  /** False when another live agent in the tenant answers to the same name; address those by id. */
  nameIsUnique: boolean;
}

export interface AgentFamilyRosterEntry {
  sessionId: string;
  name: string;
  relationship: AgentMessageRelationship;
  status: SessionSnapshot["status"];
  generation: number;
}

/**
 * Fan-out limits for child agents.
 *
 * A single instruction can otherwise turn into an unbounded tree: every child is free to spawn its
 * own children, and nothing counts how many are alive at once. Peers hit this and added exactly three
 * dials, with a notable default - a subagent does *not* spawn subagents unless an operator says so.
 */
export interface AgentFanoutStatus {
  sessionId: string;
  depth: number;
  liveChildren: number;
  lifetimeChildren: number;
  limits: Required<AgentFanoutLimits>;
  canSpawn: boolean;
  /** Which cap fired, so a caller can raise the right limit instead of guessing. */
  limit?: FanoutLimitKind;
  reason?: string;
}

const DEFAULT_FANOUT: Required<AgentFanoutLimits> = {
  maxConcurrentChildren: 20,
  // Nested spawning is off by default: it is the difference between "delegate this" and an
  // exponential tree nobody asked for. An operator who wants deeper trees can say so.
  maxDepth: 1,
  maxLifetimeChildren: 200,
};

export interface SupervisorOptions {
  dataRoot: string;
  workspaceRoot: string;
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  commandJournal: CommandJournalLike;
  leaseManager?: SessionLeaseManagerLike;
  agentInbox?: AgentInboxStore;
  agentMessageMaxChars?: number;
  agentMessageMaxPending?: number;
  agentMessageRateCapacity?: number;
  agentMessageRateRefillMs?: number;
  model: ModelProvider;
  capabilities: CapabilityBroker;
  context: ContextManager;
  /** Optional per-session effort resolution, consulted once per turn. */
  resolveEffort?: (tenantId: string, sessionId: string) => Promise<{ toolIterations: number; reasoningEffort: "low" | "medium" | "high" | "max" }>;
  /** Optional prompt-cache planner forwarded to every actor. */
  resolvePromptCache?: (input: { tenantId: string; sessionId: string; systemPrompt: string; messages: AgentMessage[] }) => Promise<{ plan: PromptCachePlanRecord; hint?: PromptCacheHint | undefined } | undefined>;
  modelName?: string;
  modelFallbacks?: string[];
  onSessionClose?: (sessionId: string) => Promise<void>;
  fanout?: AgentFanoutLimits;
}

export class Supervisor {
  private readonly actors = new Map<string, SessionActor>();
  private catalog: SessionCatalogRecord[] = [];
  private loaded = false;
  private capabilityUnsubscribe: (() => void) | undefined;
  private inboxUnsubscribe: (() => void) | undefined;
  private readonly leases: SessionLeaseManagerLike;
  private readonly agentInbox: AgentInboxStore;
  private readonly inboxOwnerId = randomUUID();
  private readonly inboxDrains = new Set<string>();
  private readonly messageRate = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly deliveryWaiters = new Map<string, { resolve: (message: AgentInboxMessage) => void; reject: (error: Error) => void }>();
  private readonly fanout: Required<AgentFanoutLimits>;

  constructor(private readonly options: SupervisorOptions) {
    this.fanout = {
      maxConcurrentChildren: Math.max(0, Math.floor(options.fanout?.maxConcurrentChildren ?? DEFAULT_FANOUT.maxConcurrentChildren)),
      maxDepth: Math.max(0, Math.floor(options.fanout?.maxDepth ?? DEFAULT_FANOUT.maxDepth)),
      maxLifetimeChildren: Math.max(0, Math.floor(options.fanout?.maxLifetimeChildren ?? DEFAULT_FANOUT.maxLifetimeChildren)),
    };
    this.leases = options.leaseManager ?? new SessionLeaseManager(options.dataRoot);
    this.agentInbox = options.agentInbox ?? new FileAgentInboxStore(options.dataRoot);
    this.capabilityUnsubscribe = options.capabilities.subscribe(async (event) => {
      await this.actors.get(event.context.sessionId)?.recordCapabilityLifecycle(event);
    });
    this.inboxUnsubscribe = this.agentInbox.subscribe((targetSessionId) => {
      queueMicrotask(() => void this.drainAgentInbox(targetSessionId));
    });
  }

  private get catalogPath(): string {
    return join(this.options.dataRoot, "catalog", "sessions.json");
  }

  private async loadCatalog(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.catalogPath, "utf8")) as unknown;
      this.catalog = Array.isArray(parsed) ? (parsed as SessionCatalogRecord[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async saveCatalog(): Promise<void> {
    await atomicWrite(this.catalogPath, `${JSON.stringify(this.catalog, null, 2)}\n`);
  }

  async createSession(input: CreateSessionInput): Promise<SessionSnapshot> {
    await this.loadCatalog();
    const sessionId = input.sessionId ?? randomUUID();
    if (this.catalog.some((item) => item.sessionId === sessionId)) throw new SessionAlreadyExistsError(sessionId);
    const workspacePath = input.workspacePath ?? join(this.options.workspaceRoot, sessionId);
    const name = input.name?.trim() || `agent-${sessionId.slice(0, 8)}`;
    if (input.parentSessionId && this.catalog.some((item) =>
      item.tenantId === input.tenantId && item.parentSessionId === input.parentSessionId && item.name === name)) {
      throw new Error(`Agent name ${JSON.stringify(name)} is already used by a sibling under this parent.`);
    }
    await mkdir(workspacePath, { recursive: true });
    const record: SessionCatalogRecord = {
      sessionId,
      tenantId: input.tenantId,
      familyId: input.familyId ?? sessionId,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
      name,
      workspacePath,
      createdAt: new Date().toISOString(),
    };
    this.catalog.push(record);
    await this.saveCatalog();
    const snapshot = createInitialSnapshot({
      ...record,
      ...(input.initialMessages ? { initialMessages: input.initialMessages } : {}),
      ...(input.agentProfile ? { agentProfile: input.agentProfile } : {}),
      ...(this.options.modelFallbacks?.length ? { modelFallbacks: this.options.modelFallbacks } : {}),
    });
    await this.leases.acquire(sessionId);
    const actor = await this.buildActor(snapshot, false);
    this.actors.set(sessionId, actor);
    await actor.initialize(false);
    if (input.parentSessionId && !input.skipParentLink) await this.getActor(input.parentSessionId).then((parent) => parent.linkChild(sessionId));
    return actor.state;
  }

  /** How deep a session sits under its family root. A root session is depth 0. */
  private depthOf(sessionId: string): number {
    let depth = 0;
    let current = this.catalog.find((item) => item.sessionId === sessionId);
    const seen = new Set<string>();
    while (current?.parentSessionId && !seen.has(current.sessionId)) {
      seen.add(current.sessionId);
      depth++;
      current = this.catalog.find((item) => item.sessionId === current!.parentSessionId);
    }
    return depth;
  }

  /** What a session's fan-out budget looks like right now, and whether it may spawn at all. */
  async fanoutStatus(sessionId: string): Promise<AgentFanoutStatus> {
    await this.loadCatalog();
    if (!this.catalog.some((item) => item.sessionId === sessionId)) throw new SessionNotFoundError(sessionId);
    const children = this.catalog.filter((item) => item.parentSessionId === sessionId);
    let live = 0;
    for (const child of children) {
      const active = this.actors.get(child.sessionId)?.state;
      const persisted = active ?? await this.options.snapshotStore.load(child.sessionId);
      if (persisted && persisted.status !== "closed") live++;
    }
    const depth = this.depthOf(sessionId);
    const status: AgentFanoutStatus = {
      sessionId,
      depth,
      liveChildren: live,
      lifetimeChildren: children.length,
      limits: { ...this.fanout },
      canSpawn: true,
    };
    if (depth >= this.fanout.maxDepth) {
      status.canSpawn = false;
      status.limit = "depth";
      status.reason = `Nesting depth ${depth} is at the limit of ${this.fanout.maxDepth}; this agent may not spawn its own agents.`;
    } else if (live >= this.fanout.maxConcurrentChildren) {
      status.canSpawn = false;
      status.limit = "concurrency";
      status.reason = `${live} child agent(s) are already live, at the concurrency limit of ${this.fanout.maxConcurrentChildren}.`;
    } else if (this.fanout.maxLifetimeChildren > 0 && children.length >= this.fanout.maxLifetimeChildren) {
      status.canSpawn = false;
      status.limit = "lifetime";
      status.reason = `This session has spawned ${children.length} agent(s), at its lifetime limit of ${this.fanout.maxLifetimeChildren}.`;
    }
    return status;
  }

  async spawnChild(input: {
    parentSessionId: string;
    name?: string;
    task: string;
    source?: CommandEnvelope["source"];
    insideParentTurn?: boolean;
    agentProfile?: SessionAgentProfile;
    /**
     * Start the child from the parent's own conversation instead of an empty one. A number carries
     * that many trailing messages; `true` carries a bounded default. Delegation stops meaning
     * "re-explain everything you already know" - but the transcript is *copied*, never shared, so the
     * child cannot rewrite the parent's history.
     */
    inheritConversation?: boolean | number;
  }): Promise<SessionSnapshot> {
    const parent = await this.getActor(input.parentSessionId);
    // Checked before any workspace is created: refusing after a git worktree exists leaves litter,
    // and the refusal has to name which limit stopped it so an operator can raise the right one.
    const fanout = await this.fanoutStatus(input.parentSessionId);
    if (!fanout.canSpawn) {
      throw new SessionLimitError(
        input.parentSessionId,
        fanout.limit ?? "concurrency",
        fanout.reason ?? "Fan-out limit reached.",
        fanout.limits,
      );
    }
    const childId = randomUUID();
    const childWorkspace = join(this.options.workspaceRoot, childId);
    await mkdir(childWorkspace, { recursive: true });
    let isolation = "empty";
    try {
      await execFileAsync("git", ["-C", parent.state.workspacePath, "rev-parse", "--verify", "HEAD"], { timeout: 5000 });
      await execFileAsync("git", ["-C", parent.state.workspacePath, "worktree", "add", "--detach", childWorkspace, "HEAD"], { timeout: 30_000 });
      isolation = "git-worktree";
    } catch {
      try {
        await cp(parent.state.workspacePath, childWorkspace, {
          recursive: true,
          force: false,
          filter: (source) => !source.split(/[\\/]/).includes(".git"),
        });
        isolation = "copy";
      } catch {
        // Empty workspace remains a safe isolation fallback.
      }
    }
    const inheritCount = input.inheritConversation === true
      ? 40
      : typeof input.inheritConversation === "number" ? Math.min(200, Math.max(1, Math.floor(input.inheritConversation))) : 0;
    const inherited = inheritCount > 0
      ? structuredClone(parent.state.messages.filter((message) => message.role !== "system").slice(-inheritCount))
      : undefined;
    const child = await this.createSession({
      tenantId: parent.state.tenantId,
      name: input.name ?? `child-${childId.slice(0, 8)}`,
      workspacePath: childWorkspace,
      familyId: parent.state.familyId,
      parentSessionId: parent.state.sessionId,
      ...((input.agentProfile ?? parent.state.agentProfile) ? { agentProfile: input.agentProfile ?? parent.state.agentProfile } : {}),
      ...(input.insideParentTurn ? { skipParentLink: true } : {}),
      ...(inherited?.length ? { initialMessages: inherited } : {}),
    });
    if (input.insideParentTurn) await parent.linkChildFromCapability(child.sessionId);
    queueMicrotask(() => {
      void this.dispatch({
        protocolVersion: 1,
        commandId: randomUUID(),
        clientId: `parent:${parent.state.sessionId}`,
        tenantId: parent.state.tenantId,
        sessionId: child.sessionId,
        kind: "session.prompt",
        source: input.source ?? "agent",
        issuedAt: new Date().toISOString(),
        payload: { text: input.task, isolation, ...(inherited?.length ? { inheritedMessages: inherited.length } : {}) },
      });
    });
    return child;
  }

  async forkSession(input: {
    sourceSessionId: string;
    messageId?: string;
    name?: string;
    includeAbandonedBranchSummary?: boolean;
  }): Promise<SessionSnapshot> {
    const sourceActor = await this.getActor(input.sourceSessionId);
    const source = sourceActor.state;
    let cutIndex = source.messages.length - 1;
    if (input.messageId) {
      cutIndex = source.messages.findIndex((message) => message.id === input.messageId);
      if (cutIndex < 0) throw new Error(`Message ${input.messageId} does not exist in session ${source.sessionId}.`);
    }
    const selected = structuredClone(source.messages.slice(0, cutIndex + 1));
    const abandoned = source.messages.slice(cutIndex + 1);
    if (input.includeAbandonedBranchSummary && abandoned.length > 0) {
      const lines = abandoned
        .filter((message) => message.role === "user" || message.role === "assistant")
        .slice(0, 30)
        .map((message) => {
          const text = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.type === "text" ? part.text : "")
            .join(" ");
          return `- ${message.role}: ${text.slice(0, 400)}`;
        });
      selected.push({
        id: randomUUID(),
        role: "system",
        timestamp: new Date().toISOString(),
        content: [{
          type: "text",
          text: `<ABANDONED_BRANCH_SUMMARY source_session="${source.sessionId}">\n${lines.join("\n")}\n</ABANDONED_BRANCH_SUMMARY>`,
        }],
      });
    }

    const workspaceKey = randomUUID();
    const workspacePath = join(this.options.workspaceRoot, workspaceKey);
    try {
      await execFileAsync("git", ["-C", source.workspacePath, "rev-parse", "--verify", "HEAD"], { timeout: 5000 });
      await execFileAsync("git", ["-C", source.workspacePath, "worktree", "add", "--detach", workspacePath, "HEAD"], { timeout: 30_000 });
    } catch {
      await mkdir(workspacePath, { recursive: true });
      try {
        await cp(source.workspacePath, workspacePath, {
          recursive: true,
          force: false,
          filter: (path) => !path.split(/[\\/]/).includes(".git"),
        });
      } catch {
        // An empty isolated workspace is preferable to silently sharing files.
      }
    }

    const forked = await this.createSession({
      tenantId: source.tenantId,
      name: input.name ?? `${source.name}-fork`,
      workspacePath,
      forkedFrom: {
        sessionId: source.sessionId,
        ...(input.messageId ? { messageId: input.messageId } : {}),
      },
      initialMessages: selected,
      ...(source.agentProfile ? { agentProfile: source.agentProfile } : {}),
    });
    await sourceActor.recordFork(forked.sessionId, input.messageId);
    return forked;
  }

  private relationship(source: SessionCatalogRecord, target: SessionCatalogRecord): AgentMessageRelationship | undefined {
    if (source.familyId !== target.familyId || source.sessionId === target.sessionId) return undefined;
    if (source.parentSessionId === target.sessionId) return "parent";
    if (target.parentSessionId === source.sessionId) return "child";
    if (source.parentSessionId && source.parentSessionId === target.parentSessionId) return "sibling";
    return undefined;
  }

  async familyRoster(sessionId: string): Promise<AgentFamilyRosterEntry[]> {
    await this.loadCatalog();
    const source = this.catalog.find((item) => item.sessionId === sessionId);
    if (!source) throw new SessionNotFoundError(sessionId);
    const entries: AgentFamilyRosterEntry[] = [];
    for (const target of this.catalog) {
      const relationship = this.relationship(source, target);
      if (!relationship) continue;
      const active = this.actors.get(target.sessionId)?.state;
      const persisted = active ?? await this.options.snapshotStore.load(target.sessionId);
      if (!persisted || persisted.tenantId !== source.tenantId) continue;
      entries.push({
        sessionId: target.sessionId,
        name: target.name,
        relationship,
        status: persisted.status,
        generation: persisted.generation,
      });
    }
    const order: Record<AgentMessageRelationship, number> = { parent: 0, sibling: 1, child: 2, external: 3 };
    return entries.sort((left, right) => order[left.relationship] - order[right.relationship] || left.name.localeCompare(right.name));
  }

  private consumeAgentMessageRate(senderSessionId: string): void {
    const capacity = this.options.agentMessageRateCapacity ?? 3;
    const refillMs = this.options.agentMessageRateRefillMs ?? 1000;
    const now = Date.now();
    const current = this.messageRate.get(senderSessionId) ?? { tokens: capacity, updatedAt: now };
    const refilled = Math.min(capacity, current.tokens + (now - current.updatedAt) / refillMs);
    if (refilled < 1) throw new Error("Agent message rate limit exceeded.");
    this.messageRate.set(senderSessionId, { tokens: refilled - 1, updatedAt: now });
  }

  private async resolveMessageTargets(input: {
    senderSessionId: string;
    targetSessionId?: string;
    receiverRole?: AgentMessageRelationship;
    receiverName?: string;
    broadcast?: boolean;
  }): Promise<AgentFamilyRosterEntry[]> {
    const roster = await this.familyRoster(input.senderSessionId);
    if (input.broadcast) {
      if (input.targetSessionId || input.receiverRole || input.receiverName) throw new Error("Broadcast cannot be combined with a specific receiver.");
      if (roster.length === 0) throw new Error("No directly reachable family agents are available for broadcast.");
      return roster;
    }
    let matches: AgentFamilyRosterEntry[];
    if (input.targetSessionId) {
      matches = roster.filter((entry) => entry.sessionId === input.targetSessionId);
    } else if (input.receiverRole) {
      matches = roster.filter((entry) => entry.relationship === input.receiverRole);
      if (input.receiverRole !== "parent") {
        if (!input.receiverName?.trim()) throw new Error("receiverName is required for sibling and child messages.");
        matches = matches.filter((entry) => entry.name === input.receiverName!.trim());
      } else if (input.receiverName) {
        throw new Error("receiverName must be omitted for parent messages.");
      }
    } else {
      throw new Error("A targetSessionId, receiverRole, or broadcast=true is required.");
    }
    if (matches.length === 0) throw new Error("Target is outside direct parent/sibling/child family reach or does not exist.");
    if (matches.length > 1) throw new Error("Agent receiver name is ambiguous within the requested family role.");
    return matches;
  }

  private receipt(message: AgentInboxMessage): AgentMessageReceipt {
    return {
      id: message.id,
      targetSessionId: message.targetSessionId,
      targetName: message.targetName,
      relationship: message.relationship,
      requestedMode: message.requestedMode,
      effectiveMode: message.effectiveMode,
      deliveryStatus: message.state === "delivered" ? "delivered" : "queued",
      queuedAt: message.createdAt,
      ...(message.deliveredAt ? { deliveredAt: message.deliveredAt } : {}),
    };
  }

  async sendAgentMessage(input: {
    senderSessionId: string;
    message: string;
    mode?: AgentMessageDeliveryMode;
    targetSessionId?: string;
    receiverRole?: AgentMessageRelationship;
    receiverName?: string;
    broadcast?: boolean;
  }): Promise<{ receipts: AgentMessageReceipt[] }> {
    const text = input.message.trim();
    const maxChars = this.options.agentMessageMaxChars ?? 16_384;
    if (!text || text.length > maxChars) throw new Error(`Agent message must contain 1 to ${maxChars} characters.`);
    const sender = await this.getSession(input.senderSessionId);
    if (sender.status === "closed") throw new Error("Closed agents cannot send messages.");
    this.consumeAgentMessageRate(input.senderSessionId);
    const targets = await this.resolveMessageTargets(input);
    return await this.deliverAgentMessages({ sender, targets, requestedMode: input.mode ?? "auto", text });
  }

  /** Shared delivery path for family and directed messages: one set of limits, one set of receipts. */
  private async deliverAgentMessages(input: {
    sender: SessionSnapshot;
    targets: AgentFamilyRosterEntry[];
    requestedMode: AgentMessageDeliveryMode;
    text: string;
  }): Promise<{ receipts: AgentMessageReceipt[] }> {
    const { sender, targets, requestedMode, text } = input;
    const maxPending = this.options.agentMessageMaxPending ?? 20;
    for (const target of targets) {
      if (await this.agentInbox.pendingCount(target.sessionId) >= maxPending) {
        throw new Error(`Target session ${target.sessionId} has reached the ${maxPending}-message pending limit.`);
      }
    }

    const records: AgentInboxMessage[] = [];
    for (const target of targets) {
      const busy = !["idle", "ready"].includes(target.status);
      const effectiveMode = requestedMode === "auto" ? (busy ? "steer" : "follow_up") : requestedMode;
      const record = newAgentInboxMessage({
        tenantId: sender.tenantId,
        familyId: sender.familyId,
        senderSessionId: sender.sessionId,
        senderName: sender.name,
        targetSessionId: target.sessionId,
        targetName: target.name,
        relationship: target.relationship === "parent" ? "child" : target.relationship === "child" ? "parent" : target.relationship === "external" ? "external" : "sibling",
        requestedMode,
        effectiveMode,
        text,
      });
      await this.agentInbox.enqueue(record);
      records.push(record);
    }

    const idleRecords = records.filter((record) => {
      const target = targets.find((item) => item.sessionId === record.targetSessionId)!;
      return ["idle", "ready"].includes(target.status);
    });
    const waits = idleRecords.map((record) => new Promise<AgentInboxMessage>((resolvePromise, reject) => {
      this.deliveryWaiters.set(record.id, { resolve: resolvePromise, reject });
    }));
    for (const record of records) queueMicrotask(() => void this.drainAgentInbox(record.targetSessionId));

    if (waits.length > 0) {
      const timeout = new Promise<undefined>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(undefined), 500);
        timer.unref();
      });
      await Promise.race([Promise.allSettled(waits), timeout]);
      for (const record of idleRecords) this.deliveryWaiters.delete(record.id);
    }
    const current = await Promise.all(records.map(async (record) => await this.agentInbox.get(record.id, record.targetSessionId) ?? record));
    return { receipts: current.map((record) => this.receipt(record)) };
  }

  /**
   * Every agent in the tenant, family or not, with the facts a sender needs before choosing one:
   * whether the name is unique, whether it is reachable by kinship, and whether it is still alive.
   *
   * A directory is not a grant. Being listed here says the agent exists, not that anyone may message
   * it - crossing a family boundary is a separate, governed act.
   */
  async directory(tenantId: string, filter: { query?: string; includeClosed?: boolean; limit?: number } = {}): Promise<AgentDirectoryEntry[]> {
    await this.loadCatalog();
    const source = filter.query?.trim().toLowerCase();
    const entries: AgentDirectoryEntry[] = [];
    const nameCounts = new Map<string, number>();
    for (const record of this.catalog) {
      if (record.tenantId !== tenantId) continue;
      if (source && !record.name.toLowerCase().includes(source) && !record.sessionId.startsWith(source)) continue;
      const active = this.actors.get(record.sessionId)?.state;
      const snapshot = active ?? await this.options.snapshotStore.load(record.sessionId);
      if (!snapshot) continue;
      if (!filter.includeClosed && snapshot.status === "closed") continue;
      nameCounts.set(record.name, (nameCounts.get(record.name) ?? 0) + 1);
      entries.push({
        sessionId: record.sessionId,
        name: record.name,
        familyId: record.familyId,
        status: snapshot.status,
        busy: Boolean(snapshot.activeTurnId),
        // "Loaded" means the actor is resident here; a session known only from disk is reachable but cold.
        resident: Boolean(active),
        depth: this.depthOf(record.sessionId),
        updatedAt: snapshot.updatedAt,
        nameIsUnique: true,
        createdAt: record.createdAt,
      });
    }
    for (const entry of entries) entry.nameIsUnique = (nameCounts.get(entry.name) ?? 0) === 1;
    return entries
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.min(Math.max(1, Math.floor(filter.limit ?? 100)), 500));
  }

  /**
   * Message a same-tenant agent outside family reach, addressed by session id or by unique name.
   *
   * The refusals are the design. A tenant boundary is never crossed. A name that matches two live
   * agents is ambiguous and is refused rather than guessed at - "I sent it to the other one called
   * builder" is not an acceptable outcome. Everything else - rate limit, pending-inbox cap, delivery
   * receipts, uncertain-delivery handling - is the machinery family messages already use, because a
   * second delivery path would be a second thing to get wrong.
   */
  async sendDirectedMessage(input: {
    senderSessionId: string;
    message: string;
    targetSessionId?: string;
    targetName?: string;
    mode?: AgentMessageDeliveryMode;
  }): Promise<{ receipts: AgentMessageReceipt[] }> {
    const text = input.message.trim();
    const maxChars = this.options.agentMessageMaxChars ?? 16_384;
    if (!text || text.length > maxChars) throw new Error(`Agent message must contain 1 to ${maxChars} characters.`);
    const sender = await this.getSession(input.senderSessionId);
    if (sender.status === "closed") throw new Error("Closed agents cannot send messages.");
    if (!input.targetSessionId && !input.targetName?.trim()) throw new Error("A targetSessionId or targetName is required.");

    const directory = await this.directory(sender.tenantId, {});
    const candidates = input.targetSessionId
      ? directory.filter((entry) => entry.sessionId === input.targetSessionId)
      : directory.filter((entry) => entry.name === input.targetName!.trim());
    if (candidates.length === 0) throw new Error("No live agent in this tenant matches that id or name.");
    if (candidates.length > 1) throw new Error(`The name ${JSON.stringify(input.targetName)} matches ${candidates.length} live agents; address it by session id.`);
    const target = candidates[0]!;
    if (target.sessionId === sender.sessionId) throw new Error("An agent cannot message itself.");

    this.consumeAgentMessageRate(input.senderSessionId);
    const roster = await this.familyRoster(sender.sessionId);
    const kinship = roster.find((entry) => entry.sessionId === target.sessionId)?.relationship;
    return await this.deliverAgentMessages({
      sender,
      targets: [{
        sessionId: target.sessionId,
        name: target.name,
        status: target.status,
        generation: 0,
        // Kinship is reported when it exists, so a receipt never claims a family tie that is not there.
        relationship: kinship ?? "external",
      }],
      requestedMode: input.mode ?? "auto",
      text,
    });
  }

  async listAgentInbox(sessionId: string, states?: AgentInboxMessage["state"][]): Promise<AgentInboxMessage[]> {
    await this.getSession(sessionId);
    return await this.agentInbox.list(sessionId, states);
  }

  private async claimSteeringMessages(sessionId: string): Promise<AgentInboxMessage[]> {
    const claimed: AgentInboxMessage[] = [];
    const limit = this.options.agentMessageMaxPending ?? 20;
    for (let index = 0; index < limit; index++) {
      const message = await this.agentInbox.claimNext(sessionId, ["steer"], this.inboxOwnerId);
      if (!message) break;
      claimed.push(message);
    }
    return claimed;
  }

  private async markInboxDelivered(message: AgentInboxMessage, deliveredAt: string): Promise<void> {
    const delivered = await this.agentInbox.markDelivered(message.id, message.targetSessionId, message.ownerId ?? this.inboxOwnerId, deliveredAt);
    this.deliveryWaiters.get(message.id)?.resolve(delivered);
    this.deliveryWaiters.delete(message.id);
  }

  private async markInboxUncertain(message: AgentInboxMessage, reason: string): Promise<void> {
    try {
      await this.agentInbox.markUncertain(message.id, message.targetSessionId, message.ownerId ?? this.inboxOwnerId, reason);
    } finally {
      this.deliveryWaiters.get(message.id)?.reject(new Error(`Agent message delivery is uncertain: ${reason}`));
      this.deliveryWaiters.delete(message.id);
    }
  }

  private formattedAgentMessage(message: AgentInboxMessage): string {
    return [
      "Agent-to-agent message received.",
      `From ${message.relationship} agent ${JSON.stringify(message.senderName)} (${message.senderSessionId}):`,
      message.text,
    ].join("\n");
  }

  private async deliverClaimedMessage(message: AgentInboxMessage): Promise<void> {
    let accepted = false;
    const result = await this.dispatch({
      protocolVersion: 1,
      commandId: message.commandId,
      clientId: `agent-inbox:${message.senderSessionId}`,
      tenantId: message.tenantId,
      sessionId: message.targetSessionId,
      kind: "agent.message",
      source: "agent",
      issuedAt: message.createdAt,
      payload: {
        text: this.formattedAgentMessage(message),
        senderSessionId: message.senderSessionId,
        agentInboxMessageId: message.id,
        deliveryMode: message.effectiveMode,
      },
    }, {
      onPromptAccepted: async (_messageId, acceptedAt) => {
        await this.markInboxDelivered(message, acceptedAt);
        accepted = true;
      },
    });
    if (!accepted) {
      await this.markInboxUncertain(message, `command_${result.status}:${result.error?.code ?? "not_accepted"}`);
    }
  }

  private async drainAgentInbox(sessionId: string): Promise<void> {
    if (this.inboxDrains.has(sessionId)) return;
    this.inboxDrains.add(sessionId);
    try {
      while (true) {
        const actor = await this.getActor(sessionId);
        if (!["idle", "ready"].includes(actor.state.status)) return;
        const message = await this.agentInbox.claimNext(sessionId, ["follow_up", "steer"], this.inboxOwnerId);
        if (!message) return;
        try {
          await this.deliverClaimedMessage(message);
        } catch (error) {
          await this.markInboxUncertain(message, `delivery_exception:${error instanceof Error ? error.name : "unknown"}`).catch(() => undefined);
          return;
        }
      }
    } catch {
      // Another process may own the session lease. The durable pending row stays
      // available for that owner; observers must not turn this into a crash loop.
    } finally {
      this.inboxDrains.delete(sessionId);
    }
  }

  async dispatch(command: CommandEnvelope, hooks: SessionDispatchHooks = {}): Promise<CommandResult> {
    const result = await this.options.commandJournal.execute(command, async () => {
      const actor = await this.getActor(command.sessionId);
      if (actor.state.tenantId !== command.tenantId) {
        return {
          commandId: command.commandId,
          status: "rejected",
          error: { code: "TENANT_MISMATCH", message: "Session does not belong to the command tenant.", retryable: false },
        };
      }
      return await actor.dispatch(command, hooks);
    });
    if (command.kind !== "session.cancel") queueMicrotask(() => void this.drainAgentInbox(command.sessionId));
    return result;
  }

  async getActor(sessionId: string): Promise<SessionActor> {
    const active = this.actors.get(sessionId);
    if (active) return active;
    await this.loadCatalog();
    const record = this.catalog.find((item) => item.sessionId === sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    const persisted = await this.options.snapshotStore.load(sessionId);
    if (!persisted) throw new SessionNotFoundError(sessionId, "no-snapshot");
    const { activeTurnId: _retiredTurn, ...persistedWithoutActiveTurn } = persisted;
    const lastSequence = await this.options.eventStore.lastSequence(sessionId);

    // A closed session is rebuilt for *reading*, not for running.
    //
    // The recovery path below sets the status to "recovering" and calls
    // `initialize`, which moves the session to "idle". Applied to a session that
    // was deliberately closed, that silently reopened it: closing released the
    // lease and dropped the actor, the next command rebuilt it as "recovering",
    // and the prompt ran. "After closing, the session retains all events but
    // accepts no new work" was not true in the process that closed it.
    //
    // So the closed status survives the rebuild, the generation is not bumped
    // (nothing here may write), the lease is not taken (a read must not fight a
    // live owner, and there is nothing to own), and `initialize` is not called.
    // A command dispatched to the rebuilt actor is then refused by the actor's
    // own state check, which reports `SESSION_NOT_RUNNABLE`.
    if (persisted.status === "closed") {
      const actor = await this.buildActor(
        { ...persistedWithoutActiveTurn, lastSequence },
        true,
      );
      this.actors.set(sessionId, actor);
      return actor;
    }

    const snapshot: SessionSnapshot = {
      ...persistedWithoutActiveTurn,
      generation: persisted.generation + 1,
      lastSequence,
      status: "recovering",
    };
    await this.leases.acquire(sessionId);
    const actor = await this.buildActor(snapshot, true);
    this.actors.set(sessionId, actor);
    await actor.initialize(true);
    return actor;
  }

  async getSession(sessionId: string): Promise<SessionSnapshot> {
    return (await this.getActor(sessionId)).state;
  }

  async taskActionFromCapability(sessionId: string, action: string, payload: Record<string, JsonValue>, turnId: string): Promise<JsonValue> {
    return await (await this.getActor(sessionId)).taskActionFromCapability(action, payload, turnId);
  }

  async listSessions(tenantId?: string): Promise<SessionSnapshot[]> {
    await this.loadCatalog();
    const output: SessionSnapshot[] = [];
    for (const record of this.catalog) {
      if (tenantId && record.tenantId !== tenantId) continue;
      try {
        output.push((await this.getActor(record.sessionId)).state);
      } catch {
        // A corrupt individual session must not hide the rest of the catalog.
      }
    }
    return output.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async buildActor(snapshot: SessionSnapshot, _recovered: boolean): Promise<SessionActor> {
    const frozenContext = await this.options.context.freeze(snapshot.tenantId, snapshot.sessionId, snapshot.agentProfile, snapshot.workspacePath);
    return new SessionActor({
      snapshot,
      eventStore: this.options.eventStore,
      snapshotStore: this.options.snapshotStore,
      model: this.options.model,
      capabilities: this.options.capabilities,
      context: this.options.context,
      frozenContext,
      ...(this.options.modelName ? { modelName: this.options.modelName } : {}),
      ...(this.options.modelFallbacks?.length ? { modelFallbacks: this.options.modelFallbacks } : {}),
      ...(this.options.resolveEffort ? { resolveEffort: this.options.resolveEffort } : {}),
      ...(this.options.resolvePromptCache ? { resolvePromptCache: this.options.resolvePromptCache } : {}),
      claimSteeringMessages: async (sessionId) => await this.claimSteeringMessages(sessionId),
      markInboxDelivered: async (message, deliveredAt) => await this.markInboxDelivered(message, deliveredAt),
      markInboxUncertain: async (message, reason) => await this.markInboxUncertain(message, reason),
      onClose: async (sessionId) => {
        await this.options.onSessionClose?.(sessionId);
        this.actors.delete(sessionId);
        await this.leases.release(sessionId);
      },
    });
  }

  async shutdown(): Promise<void> {
    this.capabilityUnsubscribe?.();
    this.capabilityUnsubscribe = undefined;
    this.inboxUnsubscribe?.();
    this.inboxUnsubscribe = undefined;
    for (const waiter of this.deliveryWaiters.values()) waiter.reject(new Error("Supervisor shut down before message delivery confirmation."));
    this.deliveryWaiters.clear();
    this.inboxDrains.clear();
    this.actors.clear();
    await this.leases.releaseAll();
  }
}
