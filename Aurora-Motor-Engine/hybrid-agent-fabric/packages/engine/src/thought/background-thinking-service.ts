import { join } from "node:path";
import { ThoughtCoreService } from "./thought-core-service.js";
import { ThoughtState, ThoughtPriority } from "./thought-core-service.js";
import { DurableJsonState } from "../util/aurora-state.js";

/**
 * Background Thinking Service - Arka planda düşünebilme sistemi.
 * 
 * Aurora boşta kaldığında:
 * - Hafızayı tarar
 * - Açık problemleri inceler
 * - Eski fikirleri değerlendirir
 * - Yeni bağlantılar arar
 * - Düşük öncelikli görevleri işler
 * 
 * Bu, Thought Loop Architecture'nın temel bir parçasıdır.
 */
interface BackgroundThinkingDurableState {
  schemaVersion: 1;
  /** P2.10: the ledger is durable — a restart resumes from measured history. */
  threads: Array<{ threadId: string; tenantId: string; startedAt: number }>;
  lastRunAt?: string;
  lastRunDurationMs: number;
  totalCycles: number;
  totalThoughtsProcessed: number;
  totalConnectionsFound: number;
}

export class BackgroundThinkingService {
  private readonly thoughtCore: ThoughtCoreService;
  /** Sleep/wake flag is deliberately in-memory: it describes THIS process. */
  private running: boolean = false;
  private stopRequested: boolean = false;
  private readonly ledger: DurableJsonState<BackgroundThinkingDurableState>;

  constructor(rootPath: string, thoughtCore?: ThoughtCoreService) {
    this.thoughtCore = thoughtCore ?? new ThoughtCoreService(rootPath);
    this.ledger = new DurableJsonState<BackgroundThinkingDurableState>(
      join(rootPath, "background-thinking", "ledger.json"),
      () => ({ schemaVersion: 1, threads: [], lastRunDurationMs: 0, totalCycles: 0, totalThoughtsProcessed: 0, totalConnectionsFound: 0 }),
      (v) => { const s = v as BackgroundThinkingDurableState; return !!s && s.schemaVersion === 1 && Array.isArray(s.threads); },
      "Background thinking ledger",
    );
  }

  /** P2.10: measured history survives restarts. */
  async init(): Promise<void> { await this.ledger.read(); }

  /**
   * Arka planda düşünme döngüsünü çalıştır.
   * Bu, sürekli çalışan bir servistir.
   */
  async runCycle(tenantId: string, options?: {
    maxIterations?: number;
    maxDurationMs?: number;
    minPriority?: ThoughtPriority;
  }): Promise<{
    iteration: number;
    thoughtsProcessed: number;
    connectionsFound: number;
    problemsReviewed: number;
    hypothesesGenerated: number;
    totalDurationMs: number;
    nextRunInMs: number;
  }> {
    const maxIterations = options?.maxIterations ?? 3;
    const maxDurationMs = options?.maxDurationMs ?? 10000;
    const minPriority = options?.minPriority ?? "P3";

    // Per-iteration budget handed to ThoughtCoreService.runBackgroundThinking,
    // which validates it with auroraInteger(_, 100, 60000, "Max duration") — an
    // INTEGER in [100, 60000]. Dividing 10000 by the default 3 iterations yields
    // 3333.333…, which fails that check, so `runCycle()` and
    // `startBackgroundThread()` threw on their default arguments every time.
    // Round down and clamp into the callee's accepted range.
    const iterations = Math.max(1, Math.floor(maxIterations));
    const perIterationMs = Math.max(100, Math.min(60_000, Math.floor(maxDurationMs / iterations)));

    const startTime = Date.now();
    let totalProcessed = 0;
    let totalConnections = 0;
    let totalProblemsReviewed = 0;
    let totalHypothesesGenerated = 0;

    const priorityOrder: ThoughtPriority[] = ["P0", "P1", "P2", "P3", "P4"];
    const minPriorityIndex = priorityOrder.indexOf(minPriority);

    // `iteration` reports how many passes ACTUALLY ran. It used to echo
    // `maxIterations` even when the duration budget broke the loop on pass one,
    // which made a truncated cycle indistinguishable from a complete one.
    let iterationsRun = 0;

    // Sadece düşük öncelikli düşünceleri işle
    for (let i = 0; i < iterations; i++) {
      // P2.10 interruption policy: a stop() between iterations takes effect
      // at the next iteration boundary; the completed iterations stay counted.
      if (this.stopRequested && i > 0) break;
      if (Date.now() - startTime > maxDurationMs) break;

      const result = await this.thoughtCore.runBackgroundThinking(tenantId, {
        maxThoughts: 20,
        maxDurationMs: perIterationMs,
      });

      iterationsRun++;
      totalProcessed += result.thoughtsProcessed;
      totalConnections += result.newConnections;
      totalProblemsReviewed += result.problemsReviewed;
      totalHypothesesGenerated += result.hypothesesGenerated;
    }

    const totalDurationMs = Date.now() - startTime;
    await this.ledger.mutate((state) => {
      state.lastRunAt = new Date().toISOString();
      state.lastRunDurationMs = totalDurationMs;
      state.totalCycles++;
      state.totalThoughtsProcessed += totalProcessed;
      state.totalConnectionsFound += totalConnections;
    });

    // Sonraki çalışma zamanını belirle (5-15 dakika arasında)
    const nextRunInMs = 5 * 60 * 1000 + Math.floor(Math.random() * 10 * 60 * 1000);

    return {
      iteration: iterationsRun,
      thoughtsProcessed: totalProcessed,
      connectionsFound: totalConnections,
      problemsReviewed: totalProblemsReviewed,
      hypothesesGenerated: totalHypothesesGenerated,
      totalDurationMs,
      nextRunInMs,
    };
  }

  /**
   * Hafızayı tarayarak yeni bağlantılar bul.
   */
  async scanMemoryForConnections(tenantId: string, options?: {
    limit?: number;
    minSimilarity?: number;
  }): Promise<{
    connectionsFound: Array<{ thoughtId1: string; thoughtId2: string; similarity: number; commonTags: string[] }>;
    thoughtsScanned: number;
  }> {
    const limit = options?.limit ?? 100;
    const minSimilarity = options?.minSimilarity ?? 0.4;

    const thoughts = await this.thoughtCore.listThoughts(tenantId, { limit });
    const connections: Array<{ thoughtId1: string; thoughtId2: string; similarity: number; commonTags: string[] }> = [];

    for (let i = 0; i < thoughts.length; i++) {
      for (let j = i + 1; j < thoughts.length && j < i + 20; j++) {
        const thought1 = thoughts[i]!;
        const thought2 = thoughts[j]!;

        // Skip if already connected
        if (thought1.relatedThoughtIds.includes(thought2.id) || thought2.relatedThoughtIds.includes(thought1.id)) {
          continue;
        }

        // Calculate similarity based on tags
        const commonTags = thought1.tags.filter((tag) => thought2.tags.includes(tag));
        const allTags = [...new Set([...thought1.tags, ...thought2.tags])];
        const similarity = allTags.length > 0 ? commonTags.length / allTags.length : 0;

        if (similarity >= minSimilarity && commonTags.length >= 2) {
          connections.push({
            thoughtId1: thought1.id,
            thoughtId2: thought2.id,
            similarity,
            commonTags,
          });
        }
      }
    }

    return {
      connectionsFound: connections,
      thoughtsScanned: thoughts.length,
    };
  }

  /**
   * Eski fikirleri yeniden değerlendir.
   * Uzun süredir aktif olmayan düşünceleri kontrol et.
   */
  async reevaluateOldThoughts(tenantId: string, options?: {
    minAgeDays?: number;
    limit?: number;
  }): Promise<{
    thoughtsReevaluated: number;
    reactivated: number;
    /**
     * Thoughts demoted from `active` to `waiting`. This used to be reported as
     * `archived`, but nothing here archives anything — the state written is
     * `waiting`. A metric named after an action that did not happen is worse
     * than no metric.
     */
    movedToWaiting: number;
  }> {
    const minAgeDays = options?.minAgeDays ?? 30;
    const limit = options?.limit ?? 50;
    const now = Date.now();

    const oldThoughts = await this.thoughtCore.listThoughts(tenantId, {
      limit,
    });

    const minAgeMs = minAgeDays * 86_400_000;
    let reevaluated = 0;
    let reactivated = 0;
    let movedToWaiting = 0;

    for (const thought of oldThoughts) {
      const ageMs = now - Date.parse(thought.updatedAt);
      if (ageMs < minAgeMs) continue;

      reevaluated++;

      // Check if thought should be reactivated based on related activity
      const relatedThoughts = await this.thoughtCore.listThoughts(tenantId, {
        limit: 10,
      });

      const hasRecentRelated = relatedThoughts.some(
        (t) =>
          thought.relatedThoughtIds.includes(t.id) &&
          (now - Date.parse(t.updatedAt)) < minAgeMs / 2
      );

      if (hasRecentRelated && thought.state === "waiting") {
        await this.thoughtCore.activateThought(tenantId, thought.id);
        reactivated++;
      } else if (!hasRecentRelated && thought.state === "active" && thought.activationCount > 5) {
        await this.thoughtCore.setWaiting(tenantId, thought.id);
        movedToWaiting++;
      }
    }

    return {
      thoughtsReevaluated: reevaluated,
      reactivated,
      movedToWaiting,
    };
  }

  /**
   * Yeni araştırma fırsatları bul.
   */
  async findResearchOpportunities(tenantId: string, options?: {
    limit?: number;
  }): Promise<{
    opportunities: Array<{ title: string; reason: string; priority: ThoughtPriority }>;
    scanned: number;
  }> {
    const limit = options?.limit ?? 100;
    const opportunities: Array<{ title: string; reason: string; priority: ThoughtPriority }> = [];

    // 1. Check for thoughts with high importance but low confidence
    const highImportanceLowConfidence = await this.thoughtCore.listThoughts(tenantId, {
      minImportance: 0.8,
      limit,
    });

    for (const thought of highImportanceLowConfidence) {
      if (thought.confidence < 0.5 && thought.state !== "researching") {
        opportunities.push({
          title: `Investigate: ${thought.title}`,
          reason: `High importance (${thought.importance}) but low confidence (${thought.confidence})`,
          priority: thought.priority,
        });
      }
    }

    // 2. Check for open problems that need attention
    const problems = await this.thoughtCore.listOpenProblems(tenantId, {
      status: "open",
      limit: 20,
    });

    for (const problem of problems) {
      if (!problem.lastReviewedAt || (Date.now() - Date.parse(problem.lastReviewedAt)) > problem.reviewIntervalDays * 86_400_000) {
        opportunities.push({
          title: `Review: ${problem.title}`,
          reason: `Open problem needs review (last reviewed ${problem.lastReviewedAt || "never"})`,
          priority: problem.priority,
        });
      }
    }

    return {
      opportunities,
      scanned: highImportanceLowConfidence.length + problems.length,
    };
  }

  /**
   * Arka plan düşünme sistemini başlat.
   * Bu, sürekli çalışan bir arka plan görevidir.
   */
  async startBackgroundThread(tenantId: string): Promise<{
    threadId: string;
    message: string;
  }> {
    // Runs one cycle inline; there is no separate thread yet. The thread IS
    // registered, so `stopBackgroundThread` can tell a real id from an invented
    // one instead of claiming success for both.
    const result = await this.runCycle(tenantId);
    const threadId = `bg-thread-${Date.now()}`;
    await this.ledger.mutate((state) => {
      state.threads.push({ threadId, tenantId, startedAt: Date.now() });
    });

    return {
      threadId,
      message: `Background thinking started. Processed ${result.thoughtsProcessed} thoughts in ${result.totalDurationMs}ms.`,
    };
  }

  /**
   * Arka plan düşünmesini durdur.
   */
  async stopBackgroundThread(threadId: string): Promise<{
    stopped: boolean;
    message: string;
  }> {
    // Previously returned `stopped: true` for ANY id, including one that was
    // never started — a fabricated success. An unknown id is now reported as
    // not stopped, which is what actually happened.
    const known = await this.ledger.mutate((state) => {
      const before = state.threads.length;
      state.threads = state.threads.filter((thread) => thread.threadId !== threadId);
      return before !== state.threads.length;
    });
    if (!known) {
      return { stopped: false, message: `Background thinking thread ${threadId} was not running.` };
    }
    return { stopped: true, message: `Background thinking thread ${threadId} stopped.` };
  }

  /**
   * Arka plan düşünme durumunu getir.
   */
  async getStatus(tenantId: string): Promise<{
    isRunning: boolean;
    lastRunAt?: string;
    lastRunDurationMs: number;
    totalCycles: number;
    totalThoughtsProcessed: number;
    totalConnectionsFound: number;
    activeThreads: number;
  }> {
    // Reports measured state only. `lastRunAt` is omitted until a cycle has
    // actually run; it used to be stamped with `new Date()` on every call, so a
    // service that had never thought claimed to have just finished a run.
    const ledger = await this.ledger.read();
    return {
      isRunning: this.running,
      ...(ledger.lastRunAt ? { lastRunAt: ledger.lastRunAt } : {}),
      lastRunDurationMs: ledger.lastRunDurationMs,
      totalCycles: ledger.totalCycles,
      totalThoughtsProcessed: ledger.totalThoughtsProcessed,
      totalConnectionsFound: ledger.totalConnectionsFound,
      activeThreads: ledger.threads.filter((thread) => thread.tenantId === tenantId).length,
    };
  }

  /**
   * Arka plan düşünme servisini başlat.
   */
  start(): void {
    this.running = true;
    this.stopRequested = false;
  }

  /**
   * Arka plan düşünme servisini durdur.
   */
  stop(): void {
    this.running = false;
    this.stopRequested = true;
    void this.ledger.mutate((state) => { state.threads = []; }).catch(() => undefined);
  }
}
