/**
 * Thought-Memory Integration Service
 * Bridges thought processing with memory graph for automatic knowledge capture.
 * When thoughts produce insights, they are automatically stored in memory.
 *
 * P0-4 FIX: Now EventBus-driven. Subscribes to thought.created events
 * and automatically processes them. No manual trigger needed.
 */

import type { EventBus, AuroraEvent } from "../aurora/event-bus.js";
import { COGNITIVE_EVENTS } from "../aurora/event-bus.js";

export interface ThoughtInsight {
  id: string;
  thoughtId: string;
  kind: "insight" | "observation" | "hypothesis" | "conclusion" | "pattern";
  content: string;
  confidence: number;
  importance: number;
  sourceType: "thought" | "reflection" | "analysis";
  tags: string[];
  relatedMemoryIds: string[];
  createdAt: string;
}

export interface MemoryBridgeConfig {
  /** Minimum confidence to auto-store thought as memory */
  minConfidenceForAutoStore: number;
  /** Minimum importance to auto-store thought as memory */
  minImportanceForAutoStore: number;
  /** Maximum memories to create per thought cycle */
  maxMemoriesPerCycle: number;
  /** Enable automatic memory consolidation */
  enableConsolidation: boolean;
  /** Consolidation interval in milliseconds */
  consolidationIntervalMs: number;
}

const DEFAULT_CONFIG: MemoryBridgeConfig = {
  minConfidenceForAutoStore: 0.6,
  minImportanceForAutoStore: 0.4,
  maxMemoriesPerCycle: 5,
  enableConsolidation: true,
  consolidationIntervalMs: 60 * 60 * 1000, // 1 hour
};

export class ThoughtMemoryIntegration {
  private config: MemoryBridgeConfig;
  private engine: any;
  private pendingInsights: ThoughtInsight[] = [];
  private processedThoughtIds = new Set<string>();
  private eventBus: EventBus | undefined;
  private subscriptionId: string | undefined;

  constructor(engine: any, config: Partial<MemoryBridgeConfig> = {}) {
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = engine.eventBus as EventBus | undefined;
  }

  /**
   * Initialize: subscribe to EventBus for automatic thought processing.
   */
  init(): void {
    if (!this.eventBus) return;
    this.subscriptionId = this.eventBus.subscribe(
      COGNITIVE_EVENTS.THOUGHT_CREATED,
      async (event: AuroraEvent) => {
        const tenantId = (event.payload.tenantId as string) ?? "local";
        const thought = event.payload.thought;
        if (thought && typeof thought === "object") {
          await this.processThought(tenantId, thought as any);
        }
      },
      10,
    );
  }

  dispose(): void {
    if (this.subscriptionId && this.eventBus) {
      this.eventBus.unsubscribe(this.subscriptionId);
      this.subscriptionId = undefined;
    }
  }

  /**
   * Process a thought and extract insights for memory storage
   */
  async processThought(tenantId: string, thought: any): Promise<ThoughtInsight[]> {
    if (this.processedThoughtIds.has(thought.id)) return [];
    this.processedThoughtIds.add(thought.id);

    const insights: ThoughtInsight[] = [];

    // Extract insights from thought content
    if (thought.type === "insight" || thought.type === "observation") {
      const insight: ThoughtInsight = {
        id: `insight-${thought.id}-${Date.now()}`,
        thoughtId: thought.id,
        kind: thought.type === "insight" ? "insight" : "observation",
        content: thought.content || thought.summary || "",
        confidence: thought.confidence ?? 0.7,
        importance: thought.importance ?? 0.5,
        sourceType: "thought",
        tags: thought.tags || [],
        relatedMemoryIds: [],
        createdAt: new Date().toISOString(),
      };
      insights.push(insight);
    }

    // Extract patterns from background thinking
    if (thought.type === "pattern" || thought.type === "trend") {
      const insight: ThoughtInsight = {
        id: `pattern-${thought.id}-${Date.now()}`,
        thoughtId: thought.id,
        kind: "pattern",
        content: thought.content || "",
        confidence: thought.confidence ?? 0.6,
        importance: thought.importance ?? 0.6,
        sourceType: "reflection",
        tags: [...(thought.tags || []), "pattern"],
        relatedMemoryIds: [],
        createdAt: new Date().toISOString(),
      };
      insights.push(insight);
    }

    // Auto-store qualifying insights
    const qualified = insights.filter(
      (i) => i.confidence >= this.config.minConfidenceForAutoStore &&
             i.importance >= this.config.minImportanceForAutoStore
    );

    const toStore = qualified.slice(0, this.config.maxMemoriesPerCycle);
    for (const insight of toStore) {
      await this.storeInsightAsMemory(tenantId, insight);
    }

    this.pendingInsights.push(...insights);
    return insights;
  }

  /**
   * Store an insight as a memory in the memory graph
   */
  private async storeInsightAsMemory(tenantId: string, insight: ThoughtInsight): Promise<string | null> {
    try {
      if (!this.engine.memoryGraph) return null;

      const memory = await this.engine.memoryGraph.createMemory({
        tenantId,
        kind: `thought-${insight.kind}`,
        content: insight.content,
        importance: insight.importance,
        confidence: insight.confidence,
        tags: [...insight.tags, "auto-captured", `thought:${insight.thoughtId}`],
      });

      insight.relatedMemoryIds.push(memory.id);
      return memory.id;
    } catch (err) {
      // Non-critical: log and continue
      return null;
    }
  }

  /**
   * Search memory for context relevant to a thought
   */
  async findRelevantContext(tenantId: string, thoughtContent: string, limit: number = 5): Promise<any[]> {
    try {
      if (!this.engine.memoryGraph) return [];
      return await this.engine.memoryGraph.search(tenantId, {
        query: thoughtContent.slice(0, 500),
        limit,
      });
    } catch {
      return [];
    }
  }

  /**
   * Get pending insights that haven't been stored yet
   */
  getPendingInsights(): ThoughtInsight[] {
    return [...this.pendingInsights];
  }

  /**
   * Clear processed thought IDs (for memory management)
   */
  clearProcessedCache(): void {
    if (this.processedThoughtIds.size > 10000) {
      const ids = Array.from(this.processedThoughtIds);
      this.processedThoughtIds = new Set(ids.slice(-5000));
    }
  }

  /**
   * Get integration statistics
   */
  stats(): {
    processedThoughts: number;
    pendingInsights: number;
    config: MemoryBridgeConfig;
  } {
    return {
      processedThoughts: this.processedThoughtIds.size,
      pendingInsights: this.pendingInsights.length,
      config: this.config,
    };
  }
}
