/**
 * Memory Consolidation — Aurora Cognitive Runtime
 *
 * Background consolidation.
 * Pattern discovery.
 * Contradiction detection.
 * Confidence tracking.
 */

import { randomUUID } from "node:crypto";

/**
 * Memory pattern.
 */
export interface MemoryPattern {
  id: string;
  type: "recurring" | "temporal" | "causal" | "associative";
  description: string;
  memoryIds: string[];
  frequency: number;
  confidence: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Contradiction.
 */
export interface Contradiction {
  id: string;
  memoryId1: string;
  memoryId2: string;
  type: "direct" | "implicit" | "temporal";
  description: string;
  severity: "low" | "medium" | "high";
  resolved: boolean;
  resolution?: string;
  detectedAt: string;
}

/**
 * Consolidation job.
 */
export interface ConsolidationJob {
  id: string;
  type: "pattern_discovery" | "contradiction_detection" | "confidence_update" | "cleanup";
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

/**
 * Memory Consolidation Manager
 * 
 * Background consolidation, pattern discovery, contradiction detection.
 */
export class MemoryConsolidationManager {
  private readonly patterns = new Map<string, MemoryPattern>();
  private readonly contradictions = new Map<string, Contradiction>();
  private readonly jobs: ConsolidationJob[] = [];
  private running = false;
  private intervalId?: ReturnType<typeof setInterval> | undefined;

  constructor(
    private memoryService: {
      list(tenantId: string, filter?: unknown): Promise<Array<{ id: string; content: string; layer: string; confidence: number; importance: number; tags: string[]; createdAt: string }>>;
      recall(tenantId: string, query: string, options?: unknown): Promise<Array<{ id: string; content: string; score: number }>>;
    },
    private config: {
      patternDiscoveryIntervalMs?: number;
      contradictionDetectionIntervalMs?: number;
      confidenceUpdateIntervalMs?: number;
      maxPatterns?: number;
      maxContradictions?: number;
    } = {}
  ) {
    this.config = {
      patternDiscoveryIntervalMs: 60000, // 1 minute
      contradictionDetectionIntervalMs: 120000, // 2 minutes
      confidenceUpdateIntervalMs: 300000, // 5 minutes
      maxPatterns: 1000,
      maxContradictions: 500,
      ...config,
    };
  }

  /**
   * Background consolidation başlat.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Pattern discovery
    this.intervalId = setInterval(() => {
      this.runPatternDiscovery().catch(console.error);
    }, this.config.patternDiscoveryIntervalMs);

    // Contradiction detection
    setInterval(() => {
      this.runContradictionDetection().catch(console.error);
    }, this.config.contradictionDetectionIntervalMs);

    // Confidence update
    setInterval(() => {
      this.runConfidenceUpdate().catch(console.error);
    }, this.config.confidenceUpdateIntervalMs);
  }

  /**
   * Background consolidation durdur.
   */
  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  /**
   * Pattern discovery çalıştır.
   */
  async runPatternDiscovery(): Promise<MemoryPattern[]> {
    const job: ConsolidationJob = {
      id: randomUUID(),
      type: "pattern_discovery",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.jobs.push(job);

    try {
      const memories = await this.memoryService.list("local");
      const patterns = this.discoverPatterns(memories);

      // Add new patterns
      for (const pattern of patterns) {
        this.patterns.set(pattern.id, pattern);
      }

      // Limit patterns
      if (this.patterns.size > this.config.maxPatterns!) {
        const sorted = [...this.patterns.values()].sort((a, b) => b.confidence - a.confidence);
        this.patterns.clear();
        for (const p of sorted.slice(0, this.config.maxPatterns!)) {
          this.patterns.set(p.id, p);
        }
      }

      job.status = "completed";
      job.completedAt = new Date().toISOString();
      job.result = patterns;

      return patterns;
    } catch (error) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Contradiction detection çalıştır.
   */
  async runContradictionDetection(): Promise<Contradiction[]> {
    const job: ConsolidationJob = {
      id: randomUUID(),
      type: "contradiction_detection",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.jobs.push(job);

    try {
      const memories = await this.memoryService.list("local");
      const contradictions = this.detectContradictions(memories);

      // Add new contradictions
      for (const contradiction of contradictions) {
        this.contradictions.set(contradiction.id, contradiction);
      }

      // Limit contradictions
      if (this.contradictions.size > this.config.maxContradictions!) {
        const sorted = [...this.contradictions.values()].sort((a, b) => {
          const severityOrder = { high: 3, medium: 2, low: 1 };
          return severityOrder[b.severity] - severityOrder[a.severity];
        });
        this.contradictions.clear();
        for (const c of sorted.slice(0, this.config.maxContradictions!)) {
          this.contradictions.set(c.id, c);
        }
      }

      job.status = "completed";
      job.completedAt = new Date().toISOString();
      job.result = contradictions;

      return contradictions;
    } catch (error) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Confidence update çalıştır.
   */
  async runConfidenceUpdate(): Promise<void> {
    const job: ConsolidationJob = {
      id: randomUUID(),
      type: "confidence_update",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.jobs.push(job);

    try {
      // Confidence update logic would go here
      // For now, just mark as completed
      job.status = "completed";
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Pattern discovery.
   */
  private discoverPatterns(memories: Array<{ id: string; content: string; tags: string[]; createdAt: string }>): MemoryPattern[] {
    const patterns: MemoryPattern[] = [];

    // Tag-based patterns
    const tagGroups = new Map<string, string[]>();
    for (const memory of memories) {
      for (const tag of memory.tags) {
        if (!tagGroups.has(tag)) tagGroups.set(tag, []);
        tagGroups.get(tag)!.push(memory.id);
      }
    }

    for (const [tag, memoryIds] of tagGroups) {
      if (memoryIds.length >= 3) {
        patterns.push({
          id: randomUUID(),
          type: "recurring",
          description: `Recurring tag: ${tag}`,
          memoryIds,
          frequency: memoryIds.length,
          confidence: Math.min(1, memoryIds.length / 10),
          firstSeen: memories.find(m => m.id === memoryIds[0])?.createdAt ?? new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        });
      }
    }

    // Temporal patterns (memories created at similar times)
    const timeGroups = this.groupByTime(memories);
    for (const [timeKey, memoryIds] of timeGroups) {
      if (memoryIds.length >= 2) {
        patterns.push({
          id: randomUUID(),
          type: "temporal",
          description: `Temporal cluster: ${timeKey}`,
          memoryIds,
          frequency: memoryIds.length,
          confidence: Math.min(1, memoryIds.length / 5),
          firstSeen: memories.find(m => m.id === memoryIds[0])?.createdAt ?? new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        });
      }
    }

    return patterns;
  }

  /**
   * Contradiction detection.
   */
  private detectContradictions(memories: Array<{ id: string; content: string; confidence: number }>): Contradiction[] {
    const contradictions: Contradiction[] = [];

    // Simple contradiction detection based on content similarity
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const m1 = memories[i]!;
        const m2 = memories[j]!;

        // Check for negation patterns
        const negationPatterns = ["not", "no", "never", "cannot", "isn't", "aren't", "doesn't", "without"];
        const m1Negations = negationPatterns.filter(p => m1.content.toLowerCase().includes(p));
        const m2Negations = negationPatterns.filter(p => m2.content.toLowerCase().includes(p));

        // If one has negations and the other doesn't, they might contradict
        if (m1Negations.length > 0 && m2Negations.length === 0) {
          // Check if content is similar
          const similarity = this.calculateSimilarity(m1.content, m2.content);
          if (similarity > 0.7) {
            contradictions.push({
              id: randomUUID(),
              memoryId1: m1.id,
              memoryId2: m2.id,
              type: "direct",
              description: `Potential contradiction: one memory has negation, other doesn't`,
              severity: similarity > 0.9 ? "high" : similarity > 0.8 ? "medium" : "low",
              resolved: false,
              detectedAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    return contradictions;
  }

  /**
   * Content similarity hesapla.
   */
  private calculateSimilarity(text1: string, text2: string): number {
    const tokens1 = new Set(text1.toLowerCase().split(/\s+/));
    const tokens2 = new Set(text2.toLowerCase().split(/\s+/));
    const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
    const union = new Set([...tokens1, ...tokens2]);
    return intersection.size / union.size;
  }

  /**
   * Time-based grouping.
   */
  private groupByTime(memories: Array<{ id: string; createdAt: string }>): Map<string, string[]> {
    const groups = new Map<string, string[]>();

    for (const memory of memories) {
      // Group by hour
      const date = new Date(memory.createdAt);
      const timeKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;

      if (!groups.has(timeKey)) groups.set(timeKey, []);
      groups.get(timeKey)!.push(memory.id);
    }

    return groups;
  }

  /**
   * Patterns al.
   */
  getPatterns(): MemoryPattern[] {
    return [...this.patterns.values()];
  }

  /**
   * Contradictions al.
   */
  getContradictions(): Contradiction[] {
    return [...this.contradictions.values()];
  }

  /**
   * Unresolved contradictions al.
   */
  getUnresolvedContradictions(): Contradiction[] {
    return [...this.contradictions.values()].filter(c => !c.resolved);
  }

  /**
   * Contradiction'ı çöz.
   */
  resolveContradiction(contradictionId: string, resolution: string): void {
    const contradiction = this.contradictions.get(contradictionId);
    if (contradiction) {
      contradiction.resolved = true;
      contradiction.resolution = resolution;
    }
  }

  /**
   * Jobs al.
   */
  getJobs(): ConsolidationJob[] {
    return [...this.jobs];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalPatterns: number;
    totalContradictions: number;
    unresolvedContradictions: number;
    totalJobs: number;
    runningJobs: number;
  } {
    return {
      totalPatterns: this.patterns.size,
      totalContradictions: this.contradictions.size,
      unresolvedContradictions: [...this.contradictions.values()].filter(c => !c.resolved).length,
      totalJobs: this.jobs.length,
      runningJobs: this.jobs.filter(j => j.status === "running").length,
    };
  }
}

/**
 * Confidence Tracker
 * 
 * Memory confidence tracking.
 */
export class ConfidenceTracker {
  private readonly confidenceHistory = new Map<string, Array<{
    timestamp: string;
    confidence: number;
    reason: string;
  }>>();

  /**
   * Confidence güncelle.
   */
  updateConfidence(memoryId: string, confidence: number, reason: string): void {
    if (!this.confidenceHistory.has(memoryId)) {
      this.confidenceHistory.set(memoryId, []);
    }

    this.confidenceHistory.get(memoryId)!.push({
      timestamp: new Date().toISOString(),
      confidence,
      reason,
    });

    // Keep last 100 entries
    const history = this.confidenceHistory.get(memoryId)!;
    if (history.length > 100) {
      this.confidenceHistory.set(memoryId, history.slice(-100));
    }
  }

  /**
   * Confidence history al.
   */
  getHistory(memoryId: string): Array<{
    timestamp: string;
    confidence: number;
    reason: string;
  }> {
    return this.confidenceHistory.get(memoryId) ?? [];
  }

  /**
   * Son confidence al.
   */
  getLatestConfidence(memoryId: string): number | undefined {
    const history = this.confidenceHistory.get(memoryId);
    return history && history.length > 0 ? history[history.length - 1]!.confidence : undefined;
  }

  /**
   * Confidence trend hesapla.
   */
  getTrend(memoryId: string): "increasing" | "decreasing" | "stable" | "unknown" {
    const history = this.confidenceHistory.get(memoryId);
    if (!history || history.length < 2) return "unknown";

    const recent = history.slice(-5);
    const avg = recent.reduce((sum, h) => sum + h.confidence, 0) / recent.length;
    const prevAvg = history.slice(-10, -5).reduce((sum, h) => sum + h.confidence, 0) / Math.max(1, history.slice(-10, -5).length);

    if (avg > prevAvg + 0.1) return "increasing";
    if (avg < prevAvg - 0.1) return "decreasing";
    return "stable";
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalTracked: number;
    avgConfidence: number;
    lowConfidenceCount: number;
  } {
    const allConfidences = [...this.confidenceHistory.values()]
      .map(h => h[h.length - 1]?.confidence ?? 0)
      .filter(c => c > 0);

    return {
      totalTracked: this.confidenceHistory.size,
      avgConfidence: allConfidences.length > 0 ? allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length : 0,
      lowConfidenceCount: allConfidences.filter(c => c < 0.3).length,
    };
  }
}
