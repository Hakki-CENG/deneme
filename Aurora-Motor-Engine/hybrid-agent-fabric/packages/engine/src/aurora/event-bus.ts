/**
 * EventBus — Aurora Cognitive Runtime
 * 
 * Servisler arası olay tabanlı iletişim.
 * Tüm cognitive lifecycle bu bus üzerinden akar.
 */

export type EventSeverity = "info" | "warning" | "critical";

export interface AuroraEvent {
  id: string;
  type: string;
  source: string;
  timestamp: number;
  severity: EventSeverity;
  payload: Record<string, unknown>;
  /** Bu olay hangi task/talep zincirine ait */
  traceId: string | undefined;
  /** Bu olay hangi cognitive phase'de üretildi */
  phase: string | undefined;
  /** Bu olaya neden olan olayın ID'si */
  causationId: string | undefined;
  /** Bu olay grubunun korelasyon ID'si */
  correlationId: string | undefined;
}

export type EventHandler = (event: AuroraEvent) => void | Promise<void>;

export interface EventSubscription {
  id: string;
  eventType: string | "*";
  handler: EventHandler;
  priority: number;
}

/** Meta Controller'ın dinlemesi gereken kritik olaylar */
export const COGNITIVE_EVENTS = {
  // Task lifecycle
  TASK_RECEIVED: "task.received",
  TASK_PROFILED: "task.profiled",
  TASK_STARTED: "task.started",
  TASK_COMPLETED: "task.completed",
  TASK_FAILED: "task.failed",

  // Thinking
  THOUGHT_CREATED: "thought.created",
  HYPOTHESIS_PROPOSED: "hypothesis.proposed",
  HYPOTHESIS_TESTED: "hypothesis.tested",
  HYPOTHESIS_CONFIRMED: "hypothesis.confirmed",
  HYPOTHESIS_REJECTED: "hypothesis.rejected",

  // Planning
  PLAN_CREATED: "plan.created",
  PLAN_STEP_STARTED: "plan.step.started",
  PLAN_STEP_COMPLETED: "plan.step.completed",
  PLAN_STEP_FAILED: "plan.step.failed",
  PLAN_ADAPTED: "plan.adapted",
  PLAN_COMPLETED: "plan.completed",

  // Memory
  MEMORY_STORED: "memory.stored",
  MEMORY_CONSOLIDATED: "memory.consolidated",
  MEMORY_RECALLED: "memory.recalled",

  // Execution
  TOOL_STARTED: "tool.started",
  TOOL_COMPLETED: "tool.completed",
  TOOL_FAILED: "tool.failed",
  AGENT_SPAWNED: "agent.spawned",
  AGENT_COMPLETED: "agent.completed",

  // Verification
  VERIFICATION_PASSED: "verification.passed",
  VERIFICATION_FAILED: "verification.failed",
  CRITIC_FLAGGED: "critic.flagged",

  // Learning
  EXPERIENCE_RECORDED: "experience.recorded",
  SKILL_GENERATED: "skill.generated",
  LESSON_LEARNED: "lesson.learned",
  PATTERN_DISCOVERED: "pattern.discovered",

  // Self-model
  BELIEF_UPDATED: "belief.updated",
  STRATEGY_CHANGED: "strategy.changed",
  CAPABILITY_ASSESSED: "capability.assessed",
  FAILURE_RECORDED: "failure.recorded",

  // Resources
  RESOURCE_ALLOCATED: "resource.allocated",
  RESOURCE_EXHAUSTED: "resource.exhausted",
  BUDGET_WARNING: "budget.warning",

  // Attention
  ATTENTION_SHIFTED: "attention.shifted",
  FOCUS_CHANGED: "focus.changed",

  // Meta Controller
  MODE_CHANGED: "mode.changed",
  SUBSYSTEM_HEALTH_CHANGED: "subsystem.health.changed",
  RECOVERY_STARTED: "recovery.started",
  CYCLE_COMPLETED: "cycle.completed",

  // Agent Society
  TRADE_OFFERED: "trade.offered",
  TRADE_COMPLETED: "trade.completed",
  REPUTATION_CHANGED: "reputation.changed",
  SWARM_TASK_SUBMITTED: "swarm.task.submitted",

  // World
  WORLD_MODEL_UPDATED: "world.updated",
  CAUSAL_LINK_DISCOVERED: "causal.discovered",
  RULE_LEARNED: "rule.learned",
} as const;

export type CognitiveEventType = (typeof COGNITIVE_EVENTS)[keyof typeof COGNITIVE_EVENTS];

let eventCounter = 0;

export class EventBus {
  private subscriptions: EventSubscription[] = [];
  private eventLog: AuroraEvent[] = [];
  private maxLogSize: number;

  constructor(maxLogSize: number = 5000) {
    this.maxLogSize = maxLogSize;
  }

  /**
   * Olay yayınla. Tüm subscriber'lar çalıştırılır.
   * Hata olan subscriber loglanır ama diğerlerini engellemez.
   */
  async emit(
    type: string,
    source: string,
    payload: Record<string, unknown>,
    opts?: { severity?: EventSeverity; traceId?: string; phase?: string; causationId?: string; correlationId?: string }
  ): Promise<AuroraEvent> {
    const event: AuroraEvent = {
      id: `evt-${Date.now()}-${++eventCounter}`,
      type,
      source,
      timestamp: Date.now(),
      severity: opts?.severity ?? "info",
      payload,
      traceId: opts?.traceId,
      phase: opts?.phase,
      causationId: opts?.causationId,
      correlationId: opts?.correlationId,
    };

    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-Math.floor(this.maxLogSize * 0.8));
    }

    // Priority'ye göre sırala (yüksek önce)
    const relevant = this.subscriptions
      .filter(s => s.eventType === "*" || s.eventType === type)
      .sort((a, b) => b.priority - a.priority);

    for (const sub of relevant) {
      try {
        await sub.handler(event);
      } catch (err) {
        // Handler hatası bus'ı durdurmaz
      }
    }

    return event;
  }

  /**
   * Olay dinle. eventType="*" ile tüm olayları dinle.
   */
  subscribe(
    eventType: string | "*",
    handler: EventHandler,
    priority: number = 0
  ): string {
    const id = `sub-${Date.now()}-${++eventCounter}`;
    this.subscriptions.push({ id, eventType, handler, priority });
    return id;
  }

  /** Belirli bir aboneliği kaldır */
  unsubscribe(subscriptionId: string): void {
    this.subscriptions = this.subscriptions.filter(s => s.id !== subscriptionId);
  }

  /** Son N olayı getir */
  getRecentEvents(count: number = 50, type?: string): AuroraEvent[] {
    const filtered = type
      ? this.eventLog.filter(e => e.type === type)
      : this.eventLog;
    return filtered.slice(-count);
  }

  /** Belirli bir trace zincirini getir */
  getTrace(traceId: string): AuroraEvent[] {
    return this.eventLog.filter(e => e.traceId === traceId);
  }

  /** Olay istatistikleri */
  getStats(): {
    totalEvents: number;
    totalSubscriptions: number;
    eventsByType: Record<string, number>;
    recentCritical: AuroraEvent[];
  } {
    const eventsByType: Record<string, number> = {};
    for (const e of this.eventLog) {
      eventsByType[e.type] = (eventsByType[e.type] ?? 0) + 1;
    }
    const recentCritical = this.eventLog
      .filter(e => e.severity === "critical")
      .slice(-20);
    return {
      totalEvents: this.eventLog.length,
      totalSubscriptions: this.subscriptions.length,
      eventsByType,
      recentCritical,
    };
  }

  // ═══ P3: Explainability ═══

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Service does not support entity lookup"], details: {} };
  }

  // ═══ Transactional Support (Outbox Pattern) ═══

  private pendingEvents: AuroraEvent[] = [];
  private inTransaction = false;

  /** Transaction başlat — olaylar buffer'a alınır */
  beginTransaction(): void {
    if (this.inTransaction) throw new Error("Transaction already in progress");
    this.inTransaction = true;
    this.pendingEvents = [];
  }

  /** Transaction'ı commit et — buffer'daki olaylar publish edilir */
  async commit(): Promise<AuroraEvent[]> {
    if (!this.inTransaction) throw new Error("No transaction in progress");
    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    this.inTransaction = false;

    // Publish all pending events
    const published: AuroraEvent[] = [];
    for (const event of events) {
      this.eventLog.push(event);
      const relevant = this.subscriptions
        .filter(s => s.eventType === "*" || s.eventType === event.type)
        .sort((a, b) => b.priority - a.priority);
      for (const sub of relevant) {
        try {
          await sub.handler(event);
        } catch {
          // Handler error doesn't stop the bus
        }
      }
      published.push(event);
    }

    // Trim log if needed
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-Math.floor(this.maxLogSize * 0.8));
    }

    return published;
  }

  /** Transaction'ı iptal et — buffer'daki olaylar atılır */
  rollback(): AuroraEvent[] {
    if (!this.inTransaction) throw new Error("No transaction in progress");
    const discarded = [...this.pendingEvents];
    this.pendingEvents = [];
    this.inTransaction = false;
    return discarded;
  }

  /** Transaction içinde olay emit et (buffer'a alınır) */
  emitInTransaction(
    type: string,
    source: string,
    payload: Record<string, unknown>,
    opts?: { severity?: EventSeverity; traceId?: string; phase?: string; causationId?: string; correlationId?: string }
  ): AuroraEvent {
    if (!this.inTransaction) throw new Error("Not in transaction — use emit() instead");
    const event: AuroraEvent = {
      id: `evt-${Date.now()}-${++eventCounter}`,
      type,
      source,
      timestamp: Date.now(),
      severity: opts?.severity ?? "info",
      payload,
      traceId: opts?.traceId,
      phase: opts?.phase,
      causationId: opts?.causationId,
      correlationId: opts?.correlationId,
    };
    this.pendingEvents.push(event);
    return event;
  }

  /** Transaction durumunu kontrol et */
  isInTransaction(): boolean {
    return this.inTransaction;
  }

  /** Buffer'daki bekleyen olayları getir */
  getPendingEvents(): AuroraEvent[] {
    return [...this.pendingEvents];
  }
}

