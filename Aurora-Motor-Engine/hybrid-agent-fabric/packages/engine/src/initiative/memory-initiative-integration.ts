/**
 * Memory-Initiative Integration Service
 * Bridges memory graph with initiative engine.
 * New memories can trigger initiative proposals.
 *
 * P0-4 FIX: EventBus-driven. Subscribes to memory.stored events
 * to automatically scan for initiative triggers.
 */

import type { EventBus, AuroraEvent } from "../aurora/event-bus.js";
import { COGNITIVE_EVENTS } from "../aurora/event-bus.js";

export interface InitiativeTrigger {
  type: "new_memory" | "memory_pattern" | "memory_gap" | "memory_decay";
  memoryId: string;
  kind: string;
  content: string;
  importance: number;
  confidence: number;
  tags: string[];
}

export interface InitiativeIntegrationConfig {
  /** Enable automatic initiative scanning on new memories */
  enableAutoScan: boolean;
  /** Minimum importance to trigger initiative scan */
  minImportanceForTrigger: number;
  /** Maximum initiatives to propose per memory event */
  maxInitiativesPerEvent: number;
  /** Cooldown between initiative scans (ms) */
  scanCooldownMs: number;
}

const DEFAULT_CONFIG: InitiativeIntegrationConfig = {
  enableAutoScan: true,
  minImportanceForTrigger: 0.6,
  maxInitiativesPerEvent: 3,
  scanCooldownMs: 5 * 60 * 1000, // 5 minutes
};

export class MemoryInitiativeIntegration {
  private config: InitiativeIntegrationConfig;
  private engine: any;
  private lastScanTime = 0;
  private triggerQueue: InitiativeTrigger[] = [];
  private eventBus: EventBus | undefined;
  private subscriptionIds: string[] = [];

  constructor(engine: any, config: Partial<InitiativeIntegrationConfig> = {}) {
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = engine.eventBus as EventBus | undefined;
  }

  /** Initialize: subscribe to EventBus for automatic initiative scanning. */
  init(): void {
    if (!this.eventBus) return;
    this.subscriptionIds.push(
      this.eventBus.subscribe(COGNITIVE_EVENTS.MEMORY_STORED, async (event: AuroraEvent) => {
        const tenantId = (event.payload.tenantId as string) ?? "local";
        const memory = event.payload;
        if (memory) await this.processNewMemory(tenantId, memory);
      }, 5),
    );
  }

  dispose(): void {
    for (const id of this.subscriptionIds) this.eventBus?.unsubscribe(id);
    this.subscriptionIds = [];
  }

  /**
   * Process a new memory and potentially trigger initiatives
   */
  async processNewMemory(tenantId: string, memory: any): Promise<void> {
    if (!this.config.enableAutoScan) return;
    if (!this.engine.initiative) return;

    const trigger: InitiativeTrigger = {
      type: "new_memory",
      memoryId: memory.id,
      kind: memory.kind || "unknown",
      content: (memory.content || "").slice(0, 500),
      importance: memory.importance ?? 0.5,
      confidence: memory.confidence ?? 0.5,
      tags: memory.tags || [],
    };

    if (trigger.importance < this.config.minImportanceForTrigger) return;

    this.triggerQueue.push(trigger);

    // Check cooldown
    const now = Date.now();
    if (now - this.lastScanTime < this.config.scanCooldownMs) return;

    await this.processTriggers(tenantId);
  }

  /**
   * Process queued triggers
   */
  private async processTriggers(tenantId: string): Promise<void> {
    if (this.triggerQueue.length === 0) return;

    const triggers = [...this.triggerQueue];
    this.triggerQueue = [];
    this.lastScanTime = Date.now();

    try {
      // P1.49: memory events flow into the proactive intake bus as typed
      // events. (This used to call `engine.initiative.scan(...)`, a method
      // that does not exist on ProactiveInitiativeService — the call always
      // threw and was swallowed, so the bridge never actually ran.)
      for (const trigger of triggers) {
        await this.engine.initiative.ingest({
          tenantId,
          source: "memory",
          summary: trigger.type === "memory_gap"
            ? `Memory gap detected: ${trigger.content.slice(0, 200)}`
            : `New ${trigger.kind} memory: ${trigger.content.slice(0, 200)}`,
          payload: { triggerType: trigger.type, memoryId: trigger.memoryId, kind: trigger.kind, importance: trigger.importance },
          tags: ["memory", String(trigger.kind)],
        });
      }
    } catch {
      // Non-critical: continue
    }
  }

  /**
   * Check for memory gaps that might need initiatives
   */
  async checkMemoryGaps(tenantId: string): Promise<void> {
    if (!this.engine.memoryGraph || !this.engine.initiative) return;

    try {
      const health = await this.engine.memoryGraph.health(tenantId);
      if (health && health.gaps && health.gaps.length > 0) {
        for (const gap of health.gaps.slice(0, 3)) {
          this.triggerQueue.push({
            type: "memory_gap",
            memoryId: "system",
            kind: "gap",
            content: gap.description || gap.title || "",
            importance: gap.importance ?? 0.5,
            confidence: 0.8,
            tags: ["gap", "system"],
          });
        }
      }
    } catch {
      // Non-critical: continue
    }
  }

  /**
   * Get trigger queue
   */
  getTriggerQueue(): InitiativeTrigger[] {
    return [...this.triggerQueue];
  }

  /**
   * Get integration statistics
   */
  stats(): {
    pendingTriggers: number;
    lastScanTime: number;
    config: InitiativeIntegrationConfig;
  } {
    return {
      pendingTriggers: this.triggerQueue.length,
      lastScanTime: this.lastScanTime,
      config: this.config,
    };
  }
}
