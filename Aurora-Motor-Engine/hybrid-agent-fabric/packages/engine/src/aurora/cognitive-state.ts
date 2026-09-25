/**
 * CognitiveState — Aurora Cognitive Runtime
 *
 * Tüm servislerin paylaştığı tek birleşik bilişsel durum.
 * Meta Controller bu state'i okuyarak karar verir.
 * Servisler bu state'i yazarak durumu günceller.
 */

export type CognitiveMode =
  | "idle"            // Görev yok
  | "observing"       // Girdi analiz ediliyor
  | "reasoning"       // Hipotez üretme / düşünme
  | "planning"        // Plan oluşturma
  | "executing"       // Plan çalıştırılıyor
  | "verifying"       // Sonuç doğrulanıyor
  | "learning"        // Deneyim çıkarılıyor
  | "recovering"      // Hata kurtarma
  | "consolidating";  // Bellek sıkıştırma / uyku

export type ConfidenceLevel = "speculative" | "uncertain" | "moderate" | "confident" | "verified";

export interface ActiveGoal {
  id: string;
  title: string;
  priority: "P0" | "P1" | "P2" | "P3" | "P4";
  progress: number;
  status: "active" | "blocked" | "completed" | "failed";
  startedAt: number;
}

export interface ActivePlan {
  id: string;
  goalId: string;
  currentStep: number;
  totalSteps: number;
  status: "executing" | "adapted" | "failed" | "completed";
}

export interface ActiveHypothesis {
  id: string;
  statement: string;
  confidence: number;
  status: "proposed" | "testing" | "confirmed" | "rejected";
}

export interface ResourceBudget {
  tokensUsed: number;
  tokensRemaining: number;
  timeElapsedMs: number;
  timeBudgetMs: number;
  memoryOperations: number;
  toolCallsMade: number;
}

export interface AttentionFocus {
  category: string;
  target: string;
  urgency: number;
  importance: number;
  since: number;
}

export interface FailureContext {
  type: string;
  description: string;
  subsystem: string;
  timestamp: number;
  recoveryAttempted: boolean;
}

export interface CognitiveStateSnapshot {
  schemaVersion: number;

  /** Şu anki cognitive mod */
  mode: CognitiveMode;

  /** Aktif görev bilgisi */
  activeGoal: ActiveGoal | null;

  /** Aktif plan */
  activePlan: ActivePlan | null;

  /** Test edilen hipotezler */
  activeHypotheses: ActiveHypothesis[];

  /** Genel güven seviyesi */
  overallConfidence: ConfidenceLevel;

  /** Kaynak bütçesi */
  resourceBudget: ResourceBudget;

  /** Dikkat odağı */
  attentionFocus: AttentionFocus | null;

  /** Son hata bağlamı */
  lastFailure: FailureContext | null;

  /** Tüm hata geçmişi */
  failureHistory: FailureContext[];

  /** Belirsizlik seviyesi (0-1) */
  uncertainty: number;

  /** Son doğrulama sonucu */
  lastVerificationResult: "pass" | "fail" | "partial" | null;

  /** Aktif şüphe sayısı */
  activeSuspicionCount: number;

  /** Başarı oranı (son 20 görev) */
  recentSuccessRate: number;

  /** Aktif ajan sayısı */
  activeAgentCount: number;

  /** Aktif araç sayısı */
  activeToolCount: number;

  /** Bu session'daki toplam görev sayısı */
  totalTasksProcessed: number;

  /** Son mode değişikliği nedeni */
  lastModeChangeReason: string;

  /** Timestamp */
  lastUpdated: number;

  /** Number of tasks currently tracked in their own slots (running + recent). */
  taskCount: number;
}

/**
 * One task's own cognitive record.
 *
 * Exists because the flat fields on CognitiveStateSnapshot are single-valued:
 * with two tasks in flight, "the active goal" is not a well-formed question.
 */
export interface TaskCognitiveSlot {
  readonly taskId: string;
  readonly tenantId: string;
  readonly startedAt: number;
  endedAt: number | null;
  goal: ActiveGoal | null;
  plan: ActivePlan | null;
  verificationResult: "pass" | "fail" | "partial" | null;
  failures: FailureContext[];
}

/** Keeps the finished-task map from growing without bound. */
const MAX_TRACKED_TASKS = 100;

const DEFAULT_STATE: CognitiveStateSnapshot = {
  schemaVersion: 2,
  mode: "idle",
  activeGoal: null,
  activePlan: null,
  activeHypotheses: [],
  overallConfidence: "moderate",
  resourceBudget: {
    tokensUsed: 0,
    tokensRemaining: 100000,
    timeElapsedMs: 0,
    timeBudgetMs: 120000,
    memoryOperations: 0,
    toolCallsMade: 0,
  },
  attentionFocus: null,
  lastFailure: null,
  failureHistory: [],
  uncertainty: 0,
  lastVerificationResult: null,
  activeSuspicionCount: 0,
  recentSuccessRate: 1.0,
  activeAgentCount: 0,
  activeToolCount: 0,
  totalTasksProcessed: 0,
  lastModeChangeReason: "initial",
  lastUpdated: Date.now(),
  taskCount: 0,
};

/**
 * CognitiveState — In-memory unified state.
 *
 * DurableJsonState kullanmaz çünkü bu state sürekli değişir
 * ve persistence gerektirmez (rekonstrüksiyon yapılabilir).
 *
 * Concurrency: a single event loop prevents torn writes, but it does NOT
 * prevent interleaving. `PlanningEngine.plan()` awaits between its writes, so
 * two concurrent plans overwrite each other's `activeGoal`/`activePlan` and a
 * reader gets whichever finished last. The flat fields below are therefore
 * "most recent task wins" — fine for a dashboard, wrong as a per-task record.
 *
 * `beginTask()` / `snapshotForTask()` give each task its own slot, and the
 * flat fields are *derived* from one of those slots rather than written
 * separately. See {@link CognitiveState.refreshFlatView}.
 */
export class CognitiveState {
  private state: CognitiveStateSnapshot;
  private history: Array<{ timestamp: number; mode: CognitiveMode; reason: string }> = [];
  /** Per-task slots, insertion-ordered so the oldest finished task is evicted first. */
  private tasks = new Map<string, TaskCognitiveSlot>();
  /**
   * The task the flat fields currently describe.
   *
   * Single-valued on purpose: the flat view answers "what is the system doing
   * right now?", which has one answer. What it must not be is *arbitrary* — the
   * previous design let every writer overwrite `activeGoal`/`activePlan`
   * directly, so with two plans in flight the answer was whichever `await`
   * happened to resume last.
   */
  private focusedTaskId: string | null = null;

  constructor() {
    this.state = { ...DEFAULT_STATE };
  }

  // ═══ Per-task slots (P0-2) ═══

  /** Start tracking a task. Re-registering an existing id is a no-op. */
  beginTask(taskId: string, tenantId: string): void {
    if (this.tasks.has(taskId)) return;
    this.tasks.set(taskId, {
      taskId,
      tenantId,
      startedAt: Date.now(),
      endedAt: null,
      goal: null,
      plan: null,
      verificationResult: null,
      failures: [],
    });
    // The newest task is what an operator looking at the dashboard means by
    // "the active goal". Stating that as a rule is what makes the flat view
    // reproducible instead of a race outcome.
    this.focusedTaskId = taskId;
    this.evictFinishedTasks();
    this.refreshFlatView();
  }

  /** Mark a task finished. Its slot stays readable until evicted. */
  endTask(taskId: string): void {
    const slot = this.tasks.get(taskId);
    if (!slot) return;
    slot.endedAt = Date.now();
    // Focus must not stay on a finished task: the flat view would keep
    // reporting a goal nobody is working on.
    if (this.focusedTaskId === taskId) this.focusedTaskId = this.newestRunningTaskId();
    this.evictFinishedTasks();
    this.refreshFlatView();
  }

  /** Which task the flat fields describe, or null when nothing is running. */
  focusedTask(): string | null {
    return this.focusedTaskId;
  }

  private newestRunningTaskId(): string | null {
    let newest: TaskCognitiveSlot | null = null;
    for (const slot of this.tasks.values()) {
      if (slot.endedAt !== null) continue;
      if (!newest || slot.startedAt > newest.startedAt) newest = slot;
    }
    return newest?.taskId ?? null;
  }

  /**
   * Recompute the flat fields from the focused task's slot.
   *
   * This is the whole of the fix for "two concurrent plans overwrite each
   * other": there is now exactly one writer of `activeGoal` and `activePlan`,
   * and it copies from a slot that belongs to a named task. A reader of the
   * flat view can always ask `focusedTask()` to learn whose goal it is looking
   * at, which was not answerable before.
   */
  private refreshFlatView(): void {
    const slot = this.focusedTaskId ? this.tasks.get(this.focusedTaskId) : undefined;
    this.state.activeGoal = slot?.goal ?? null;
    this.state.activePlan = slot?.plan ?? null;
    this.state.taskCount = this.tasks.size;
    this.state.lastUpdated = Date.now();
  }

  /** Read one task's record. Null when the task was never begun. */
  snapshotForTask(taskId: string): TaskCognitiveSlot | null {
    const slot = this.tasks.get(taskId);
    return slot ? { ...slot, failures: [...slot.failures] } : null;
  }

  /** Tasks that have not ended yet. */
  runningTasks(): TaskCognitiveSlot[] {
    return [...this.tasks.values()]
      .filter((t) => t.endedAt === null)
      .map((t) => ({ ...t, failures: [...t.failures] }));
  }

  /**
   * Set a task's goal.
   *
   * Writes the slot. The flat field moves only if this is the focused task, so
   * a background task finishing cannot replace the goal an operator is looking
   * at — which is what the old unconditional mirror did.
   */
  setActiveGoalFor(taskId: string, goal: ActiveGoal | null): void {
    const slot = this.tasks.get(taskId);
    if (!slot) return;
    slot.goal = goal;
    if (this.focusedTaskId === taskId) this.refreshFlatView();
  }

  /** Set a task's plan. Same rule as {@link setActiveGoalFor}. */
  setActivePlanFor(taskId: string, plan: ActivePlan | null): void {
    const slot = this.tasks.get(taskId);
    if (!slot) return;
    slot.plan = plan;
    if (this.focusedTaskId === taskId) this.refreshFlatView();
  }

  /** Record which task a verdict belongs to. */
  setVerificationResultFor(taskId: string, result: "pass" | "fail" | "partial" | null): void {
    const slot = this.tasks.get(taskId);
    if (!slot) return;
    slot.verificationResult = result;
    this.setVerificationResult(result);
  }

  /**
   * Attribute a failure to the task that produced it.
   *
   * The global `lastFailure` / `failureHistory` still record it: "what went
   * wrong most recently, anywhere" is a real question with a real answer. What
   * changed is that the failure is also attached to a named task, so "why did
   * *this* task fail" is answerable too.
   */
  recordFailureFor(taskId: string, failure: FailureContext): void {
    const slot = this.tasks.get(taskId);
    if (!slot) return;
    slot.failures.push(failure);
    this.recordFailure(failure);
  }

  /** Drop the oldest finished tasks once the map exceeds its bound. */
  private evictFinishedTasks(): void {
    if (this.tasks.size <= MAX_TRACKED_TASKS) return;
    for (const [id, slot] of this.tasks) {
      if (this.tasks.size <= MAX_TRACKED_TASKS) break;
      if (slot.endedAt !== null) this.tasks.delete(id);
    }
  }

  /** Tüm state'i oku (snapshot) */
  snapshot(): CognitiveStateSnapshot {
    return { ...this.state };
  }

  /** Mode değiştir */
  setMode(mode: CognitiveMode, reason: string): void {
    const prev = this.state.mode;
    if (prev !== mode) {
      this.history.push({ timestamp: Date.now(), mode, reason });
      if (this.history.length > 200) {
        this.history = this.history.slice(-150);
      }
    }
    this.state.mode = mode;
    this.state.lastModeChangeReason = reason;
    this.state.lastUpdated = Date.now();
  }

  getMode(): CognitiveMode {
    return this.state.mode;
  }

  // `setActiveGoal` and `setActivePlan` were removed.
  //
  // They let any caller declare "the" active goal without saying whose it was,
  // which is the ambiguity the per-task slots exist to remove. Nothing in the
  // engine called them; the flat fields are written only by `refreshFlatView`.
  // Use `beginTask` + `setActiveGoalFor`.

  /** Hipotez ekle/güncelle */
  updateHypothesis(h: ActiveHypothesis): void {
    const idx = this.state.activeHypotheses.findIndex(x => x.id === h.id);
    if (idx >= 0) {
      this.state.activeHypotheses[idx] = h;
    } else {
      this.state.activeHypotheses.push(h);
    }
    // Tamamlanan hipotezleri temizle
    this.state.activeHypotheses = this.state.activeHypotheses.filter(
      x => x.status === "proposed" || x.status === "testing"
    );
    this.state.lastUpdated = Date.now();
  }

  /** Kaynak bütçesini güncelle */
  updateBudget(delta: Partial<ResourceBudget>): void {
    Object.assign(this.state.resourceBudget, delta);
    this.state.lastUpdated = Date.now();
  }

  /** Dikkat odağını değiştir */
  setAttentionFocus(focus: AttentionFocus | null): void {
    this.state.attentionFocus = focus;
    this.state.lastUpdated = Date.now();
  }

  /** Güven seviyesini güncelle */
  setConfidence(level: ConfidenceLevel): void {
    this.state.overallConfidence = level;
    this.state.lastUpdated = Date.now();
  }

  /** Hata bağlamını kaydet */
  recordFailure(failure: FailureContext): void {
    this.state.lastFailure = failure;
    this.state.failureHistory.push(failure);
    // Keep last 100 failures
    if (this.state.failureHistory.length > 100) {
      this.state.failureHistory = this.state.failureHistory.slice(-100);
    }
    this.state.lastUpdated = Date.now();
  }

  /** Başarı oranını güncelle */
  updateSuccessRate(success: boolean): void {
    // Basit exponential moving average
    const alpha = 0.15;
    const current = this.state.recentSuccessRate;
    this.state.recentSuccessRate = current * (1 - alpha) + (success ? 1 : 0) * alpha;
    this.state.totalTasksProcessed++;
    this.state.lastUpdated = Date.now();
  }

  /** Ajan/tool sayılarını güncelle */
  setActiveCounts(agents: number, tools: number): void {
    this.state.activeAgentCount = agents;
    this.state.activeToolCount = tools;
    this.state.lastUpdated = Date.now();
  }

  /** Mode geçmişini getir */
  getModeHistory(): Array<{ timestamp: number; mode: CognitiveMode; reason: string }> {
    return [...this.history];
  }

  /** State'i sıfırla (yeni session) */
  reset(): void {
    this.state = { ...DEFAULT_STATE, taskCount: 0 };
    this.history = [];
    this.tasks.clear();
  }

  /** Belirsizlik seviyesini güncelle */
  setUncertainty(level: number): void {
    this.state.uncertainty = Math.max(0, Math.min(1, level));
    this.state.lastUpdated = Date.now();
  }

  /** Son doğrulama sonucunu kaydet */
  setVerificationResult(result: "pass" | "fail" | "partial" | null): void {
    this.state.lastVerificationResult = result;
    this.state.lastUpdated = Date.now();
  }

  /** Aktif şüphe sayısını güncelle */
  setActiveSuspicionCount(count: number): void {
    this.state.activeSuspicionCount = count;
    this.state.lastUpdated = Date.now();
  }

  getStats() {
    return { currentMode: this.state.mode, historyLength: this.history.length, lastChange: this.history.length > 0 ? this.history[this.history.length - 1] : null };
  }

  // ═══ P3: Explainability ═══

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Service does not support entity lookup"], details: {} };
  }
}

