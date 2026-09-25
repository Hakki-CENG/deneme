/**
 * Stuck-Evolution Integration Service
 * Bridges stuck detection with evolution service.
 * Stuck patterns automatically create skill gaps.
 *
 * P0-4 FIX: EventBus-driven. Subscribes to task.failed events
 * to automatically detect stuck patterns and create capability gaps.
 */

import type { EventBus, AuroraEvent } from "../aurora/event-bus.js";
import { COGNITIVE_EVENTS } from "../aurora/event-bus.js";

export interface StuckPattern {
  id: string;
  type: "repeated_error" | "low_progress" | "capability_gap" | "knowledge_gap";
  description: string;
  frequency: number;
  lastOccurrence: string;
  relatedCapabilities: string[];
  severity: "low" | "medium" | "high" | "critical";
}

export interface StuckEvolutionConfig {
  /** Enable automatic gap creation from stuck patterns */
  enableAutoGapCreation: boolean;
  /** Minimum frequency to create a gap */
  minFrequencyForGap: number;
  /** Minimum severity to create a gap */
  minSeverityForGap: "low" | "medium" | "high" | "critical";
  /** Cooldown between gap creations for same pattern (ms) */
  gapCreationCooldownMs: number;
}

const DEFAULT_CONFIG: StuckEvolutionConfig = {
  enableAutoGapCreation: true,
  minFrequencyForGap: 3,
  minSeverityForGap: "medium",
  gapCreationCooldownMs: 24 * 60 * 60 * 1000, // 24 hours
};

const SEVERITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

export class StuckEvolutionIntegration {
  private config: StuckEvolutionConfig;
  private engine: any;
  private processedPatterns = new Map<string, number>(); // patternId -> lastGapCreationTime
  private eventBus: EventBus | undefined;
  private subscriptionIds: string[] = [];

  constructor(engine: any, config: Partial<StuckEvolutionConfig> = {}) {
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = engine.eventBus as EventBus | undefined;
  }

  /** Initialize: subscribe to EventBus for automatic stuck detection. */
  init(): void {
    if (!this.eventBus) return;
    this.subscriptionIds.push(
      this.eventBus.subscribe(COGNITIVE_EVENTS.TASK_FAILED, async (event: AuroraEvent) => {
        const tenantId = (event.payload.tenantId as string) ?? "local";
        const desc = (event.payload.description as string) ?? "task failed";
        const subsystem = (event.payload.source as string) ?? "unknown";
        await this.processStuckPattern(tenantId, {
          id: `evt-${event.id}`,
          type: "repeated_error",
          description: desc,
          frequency: 1,
          lastOccurrence: new Date().toISOString(),
          relatedCapabilities: [subsystem],
          severity: "medium",
        });
      }, 5),
    );
  }

  dispose(): void {
    for (const id of this.subscriptionIds) this.eventBus?.unsubscribe(id);
    this.subscriptionIds = [];
  }

  /**
   * Process a stuck pattern and potentially create a skill gap
   */
  async processStuckPattern(tenantId: string, pattern: StuckPattern): Promise<boolean> {
    if (!this.config.enableAutoGapCreation) return false;
    if (!this.engine.evolution) return false;

    // Check severity threshold
    if (SEVERITY_ORDER[pattern.severity] < SEVERITY_ORDER[this.config.minSeverityForGap]) return false;

    // Check frequency threshold
    if (pattern.frequency < this.config.minFrequencyForGap) return false;

    // Check cooldown
    const lastCreation = this.processedPatterns.get(pattern.id) || 0;
    const now = Date.now();
    if (now - lastCreation < this.config.gapCreationCooldownMs) return false;

    // Create skill gap
    try {
      await this.engine.evolution.createGap({
        tenantId,
        title: `Stuck Pattern: ${pattern.description.slice(0, 200)}`,
        description: `Auto-detected stuck pattern:\n\nType: ${pattern.type}\nFrequency: ${pattern.frequency}\nSeverity: ${pattern.severity}\n\n${pattern.description}`,
        severity: pattern.severity,
        relatedCapabilities: pattern.relatedCapabilities,
      });

      this.processedPatterns.set(pattern.id, now);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Scan for stuck patterns and process them
   */
  async scanAndProcess(tenantId: string): Promise<number> {
    if (!this.engine.stuckDetection || !this.engine.evolution) return 0;

    try {
      const patterns = await this.engine.stuckDetection.patterns(tenantId);
      let created = 0;

      for (const pattern of patterns || []) {
        const success = await this.processStuckPattern(tenantId, pattern);
        if (success) created++;
      }

      return created;
    } catch {
      return 0;
    }
  }

  /**
   * Get processed patterns
   */
  getProcessedPatterns(): Map<string, number> {
    return new Map(this.processedPatterns);
  }

  /**
   * Get integration statistics
   */
  stats(): {
    processedPatterns: number;
    config: StuckEvolutionConfig;
  } {
    return {
      processedPatterns: this.processedPatterns.size,
      config: this.config,
    };
  }
}
