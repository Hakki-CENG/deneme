/**
 * World-Thought Integration Service
 * Bridges thought processing with world model for automatic world state updates.
 * When thoughts contain world-relevant information, the world model is updated.
 *
 * P0-4 FIX: EventBus-driven. Subscribes to thought.created and hypothesis.confirmed
 * events to automatically update the world model.
 */

import type { EventBus, AuroraEvent } from "../aurora/event-bus.js";
import { COGNITIVE_EVENTS } from "../aurora/event-bus.js";

export interface WorldUpdate {
  entityId: string;
  key: string;
  value: string;
  confidence: number;
  sourceType: "thought" | "observation" | "inference";
  sourceId: string;
  observedAt: string;
}

export interface WorldIntegrationConfig {
  /** Enable automatic entity extraction from thoughts */
  enableAutoEntityExtraction: boolean;
  /** Enable automatic state updates from thoughts */
  enableAutoStateUpdates: boolean;
  /** Minimum confidence for auto world updates */
  minConfidenceForUpdate: number;
  /** Entity types to track */
  trackedEntityTypes: string[];
}

const DEFAULT_CONFIG: WorldIntegrationConfig = {
  enableAutoEntityExtraction: true,
  enableAutoStateUpdates: true,
  minConfidenceForUpdate: 0.7,
  trackedEntityTypes: ["person", "project", "tool", "service", "concept", "goal"],
};

export class WorldThoughtIntegration {
  private config: WorldIntegrationConfig;
  private engine: any;
  private pendingUpdates: WorldUpdate[] = [];
  private eventBus: EventBus | undefined;
  private subscriptionIds: string[] = [];

  constructor(engine: any, config: Partial<WorldIntegrationConfig> = {}) {
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = engine.eventBus as EventBus | undefined;
  }

  /** Initialize: subscribe to EventBus for automatic world updates. */
  init(): void {
    if (!this.eventBus) return;
    // Auto-update world model when hypotheses are confirmed
    this.subscriptionIds.push(
      this.eventBus.subscribe(COGNITIVE_EVENTS.HYPOTHESIS_CONFIRMED, async (event: AuroraEvent) => {
        const tenantId = (event.payload.tenantId as string) ?? "local";
        await this.processThought(tenantId, event.payload);
      }, 5),
    );
  }

  dispose(): void {
    for (const id of this.subscriptionIds) this.eventBus?.unsubscribe(id);
    this.subscriptionIds = [];
  }

  /**
   * Process a thought and update world model if relevant
   */
  async processThought(tenantId: string, thought: any): Promise<WorldUpdate[]> {
    const updates: WorldUpdate[] = [];

    if (!this.config.enableAutoStateUpdates) return updates;
    if (!this.engine.worldModel) return updates;

    // Extract entity mentions from thought content
    const content = thought.content || thought.summary || "";
    if (!content) return updates;

    // Look for existing entities that might be referenced
    try {
      const entities = await this.engine.worldModel.entities(tenantId, {});
      const relevantEntities = entities.filter((e: any) =>
        content.toLowerCase().includes(e.name.toLowerCase())
      );

      for (const entity of relevantEntities.slice(0, 5)) {
        const update: WorldUpdate = {
          entityId: entity.id,
          key: "thought-relevance",
          value: content.slice(0, 1000),
          confidence: thought.confidence ?? 0.6,
          sourceType: "thought",
          sourceId: thought.id,
          observedAt: new Date().toISOString(),
        };

        if (update.confidence >= this.config.minConfidenceForUpdate) {
          await this.applyUpdate(tenantId, update);
          updates.push(update);
        }
      }
    } catch {
      // Non-critical: continue
    }

    this.pendingUpdates.push(...updates);
    return updates;
  }

  /**
   * Apply a world model update
   */
  private async applyUpdate(tenantId: string, update: WorldUpdate): Promise<void> {
    try {
      await this.engine.worldModel.recordState({
        tenantId,
        entityId: update.entityId,
        key: update.key,
        value: update.value,
        confidence: update.confidence,
        sourceType: update.sourceType,
        sourceId: update.sourceId,
        observedAt: update.observedAt,
      });
    } catch {
      // Non-critical: continue
    }
  }

  /**
   * Get pending updates
   */
  getPendingUpdates(): WorldUpdate[] {
    return [...this.pendingUpdates];
  }

  /**
   * Get integration statistics
   */
  stats(): {
    pendingUpdates: number;
    config: WorldIntegrationConfig;
  } {
    return {
      pendingUpdates: this.pendingUpdates.length,
      config: this.config,
    };
  }
}
