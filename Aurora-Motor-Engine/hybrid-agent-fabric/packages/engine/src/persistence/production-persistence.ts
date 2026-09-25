/**
 * Production Persistence — Aurora Cognitive Runtime
 *
 * StateBackend interface.
 * Transactional event store.
 * Trajectory replay.
 */

import { randomUUID } from "node:crypto";

/**
 * State backend interface.
 */
export interface StateBackend {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

/**
 * Persistence event.
 */
export interface PersistenceEvent {
  id: string;
  type: string;
  aggregateId: string;
  data: unknown;
  metadata: Record<string, unknown>;
  version: number;
  timestamp: string;
}

/**
 * PersistenceEvent batch.
 */
export interface EventBatch {
  id: string;
  events: PersistenceEvent[];
  committed: boolean;
  timestamp: string;
}

/**
 * Trajectory.
 */
export interface Trajectory {
  id: string;
  agentId: string;
  taskId: string;
  events: PersistenceEvent[];
  startTime: string;
  endTime?: string;
  status: "active" | "completed" | "failed";
  metadata: Record<string, unknown>;
}

/**
 * Replay result.
 */
export interface ReplayResult {
  id: string;
  trajectoryId: string;
  eventsReplayed: number;
  duration: number;
  success: boolean;
  error?: string | undefined;
  timestamp: string;
}

/**
 * In-Memory State Backend
 * 
 * StateBackend interface implementation.
 */
export class InMemoryStateBackend implements StateBackend {
  private readonly store = new Map<string, unknown>();

  async get(key: string): Promise<unknown | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalKeys: number;
    estimatedSize: number;
  } {
    return {
      totalKeys: this.store.size,
      estimatedSize: JSON.stringify([...this.store.entries()]).length,
    };
  }
}

/**
 * Transactional PersistenceEvent Store
 * 
 * Transactional event store.
 */
export class TransactionalEventStore {
  private readonly events = new Map<string, PersistenceEvent>();
  private readonly batches = new Map<string, EventBatch>();
  private readonly aggregateVersions = new Map<string, number>();

  /**
   * PersistenceEvent oluştur.
   */
  createEvent(params: {
    type: string;
    aggregateId: string;
    data: unknown;
    metadata?: Record<string, unknown>;
  }): PersistenceEvent {
    const currentVersion = this.aggregateVersions.get(params.aggregateId) ?? 0;
    const newVersion = currentVersion + 1;

    const event: PersistenceEvent = {
      id: randomUUID(),
      type: params.type,
      aggregateId: params.aggregateId,
      data: params.data,
      metadata: params.metadata ?? {},
      version: newVersion,
      timestamp: new Date().toISOString(),
    };

    this.events.set(event.id, event);
    this.aggregateVersions.set(params.aggregateId, newVersion);

    return event;
  }

  /**
   * PersistenceEvent batch oluştur.
   */
  createBatch(events: Omit<PersistenceEvent, "id" | "version" | "timestamp">[]): EventBatch {
    const batchEvents: PersistenceEvent[] = events.map(e => {
      const currentVersion = this.aggregateVersions.get(e.aggregateId) ?? 0;
      const newVersion = currentVersion + 1;
      this.aggregateVersions.set(e.aggregateId, newVersion);

      return {
        ...e,
        id: randomUUID(),
        version: newVersion,
        timestamp: new Date().toISOString(),
      };
    });

    const batch: EventBatch = {
      id: randomUUID(),
      events: batchEvents,
      committed: false,
      timestamp: new Date().toISOString(),
    };

    this.batches.set(batch.id, batch);
    return batch;
  }

  /**
   * Batch'i commit et.
   */
  commitBatch(batchId: string): boolean {
    const batch = this.batches.get(batchId);
    if (!batch) return false;

    batch.committed = true;
    for (const event of batch.events) {
      this.events.set(event.id, event);
    }

    return true;
  }

  /**
   * Aggregate'in event'lerini al.
   */
  getEventsByAggregate(aggregateId: string): PersistenceEvent[] {
    return [...this.events.values()]
      .filter(e => e.aggregateId === aggregateId)
      .sort((a, b) => a.version - b.version);
  }

  /**
   * Type'a göre event'leri al.
   */
  getEventsByType(type: string): PersistenceEvent[] {
    return [...this.events.values()].filter(e => e.type === type);
  }

  /**
   * PersistenceEvent'leri al.
   */
  getEvents(): PersistenceEvent[] {
    return [...this.events.values()].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  /**
   * Aggregate version'ını al.
   */
  getVersion(aggregateId: string): number {
    return this.aggregateVersions.get(aggregateId) ?? 0;
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalEvents: number;
    totalBatches: number;
    committedBatches: number;
    totalAggregates: number;
  } {
    const batches = [...this.batches.values()];
    return {
      totalEvents: this.events.size,
      totalBatches: batches.length,
      committedBatches: batches.filter(b => b.committed).length,
      totalAggregates: this.aggregateVersions.size,
    };
  }
}

/**
 * Trajectory Manager
 * 
 * Trajectory replay.
 */
export class TrajectoryManager {
  private readonly trajectories = new Map<string, Trajectory>();
  private readonly replayResults = new Map<string, ReplayResult>();

  /**
   * Trajectory oluştur.
   */
  createTrajectory(params: {
    agentId: string;
    taskId: string;
    metadata?: Record<string, unknown>;
  }): Trajectory {
    const id = randomUUID();
    const trajectory: Trajectory = {
      id,
      agentId: params.agentId,
      taskId: params.taskId,
      events: [],
      startTime: new Date().toISOString(),
      status: "active",
      metadata: params.metadata ?? {},
    };
    this.trajectories.set(id, trajectory);
    return trajectory;
  }

  /**
   * Trajectory'ye event ekle.
   */
  addEvent(trajectoryId: string, event: PersistenceEvent): boolean {
    const trajectory = this.trajectories.get(trajectoryId);
    if (!trajectory || trajectory.status !== "active") return false;

    trajectory.events.push(event);
    return true;
  }

  /**
   * Trajectory'yi tamamla.
   */
  completeTrajectory(trajectoryId: string): boolean {
    const trajectory = this.trajectories.get(trajectoryId);
    if (!trajectory) return false;

    trajectory.status = "completed";
    trajectory.endTime = new Date().toISOString();
    return true;
  }

  /**
   * Trajectory'yi başarısız yap.
   */
  failTrajectory(trajectoryId: string): boolean {
    const trajectory = this.trajectories.get(trajectoryId);
    if (!trajectory) return false;

    trajectory.status = "failed";
    trajectory.endTime = new Date().toISOString();
    return true;
  }

  /**
   * Trajectory'yi replay et.
   */
  async replayTrajectory(params: {
    trajectoryId: string;
    handler: (event: PersistenceEvent) => Promise<void>;
    speed?: number; // 1 = normal, 2 = 2x faster
  }): Promise<ReplayResult> {
    const trajectory = this.trajectories.get(params.trajectoryId);
    if (!trajectory) {
      throw new Error(`Trajectory not found: ${params.trajectoryId}`);
    }

    const startTime = Date.now();
    let eventsReplayed = 0;
    let error: string | undefined;

    try {
      for (const event of trajectory.events) {
        await params.handler(event);
        eventsReplayed++;

        // Speed control
        if (params.speed && params.speed > 1) {
          await new Promise(resolve => setTimeout(resolve, 100 / params.speed!));
        }
      }
    } catch (err) {
      error = String(err);
    }

    const duration = Date.now() - startTime;

    const result: ReplayResult = {
      id: randomUUID(),
      trajectoryId: params.trajectoryId,
      eventsReplayed,
      duration,
      success: !error,
      error,
      timestamp: new Date().toISOString(),
    };

    this.replayResults.set(result.id, result);
    return result;
  }

  /**
   * Trajectory'leri al.
   */
  getTrajectories(): Trajectory[] {
    return [...this.trajectories.values()];
  }

  /**
   * Agent'a göre trajectory'leri al.
   */
  getTrajectoriesByAgent(agentId: string): Trajectory[] {
    return [...this.trajectories.values()].filter(t => t.agentId === agentId);
  }

  /**
   * Replay sonuçlarını al.
   */
  getReplayResults(): ReplayResult[] {
    return [...this.replayResults.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalTrajectories: number;
    activeTrajectories: number;
    completedTrajectories: number;
    failedTrajectories: number;
    totalReplays: number;
    successfulReplays: number;
  } {
    const trajectories = [...this.trajectories.values()];
    const replays = [...this.replayResults.values()];
    return {
      totalTrajectories: trajectories.length,
      activeTrajectories: trajectories.filter(t => t.status === "active").length,
      completedTrajectories: trajectories.filter(t => t.status === "completed").length,
      failedTrajectories: trajectories.filter(t => t.status === "failed").length,
      totalReplays: replays.length,
      successfulReplays: replays.filter(r => r.success).length,
    };
  }
}

/**
 * Production Persistence Pipeline
 * 
 * StateBackend + Transactional event store + Trajectory replay.
 */
export class ProductionPersistencePipeline {
  readonly stateBackend: InMemoryStateBackend;
  readonly eventStore: TransactionalEventStore;
  readonly trajectoryManager: TrajectoryManager;

  constructor() {
    this.stateBackend = new InMemoryStateBackend();
    this.eventStore = new TransactionalEventStore();
    this.trajectoryManager = new TrajectoryManager();
  }

  /**
   * State kaydet.
   */
  async saveState(key: string, value: unknown): Promise<void> {
    await this.stateBackend.set(key, value);

    // PersistenceEvent oluştur
    this.eventStore.createEvent({
      type: "state.saved",
      aggregateId: key,
      data: { key, value },
    });
  }

  /**
   * State yükle.
   */
  async loadState(key: string): Promise<unknown | null> {
    return this.stateBackend.get(key);
  }

  /**
   * Trajectory oluştur ve event ekle.
   */
  createTrajectoryWithEvent(params: {
    agentId: string;
    taskId: string;
    eventType: string;
    eventData: unknown;
  }): Trajectory {
    // Trajectory oluştur
    const trajectory = this.trajectoryManager.createTrajectory({
      agentId: params.agentId,
      taskId: params.taskId,
    });

    // PersistenceEvent oluştur
    const event = this.eventStore.createEvent({
      type: params.eventType,
      aggregateId: trajectory.id,
      data: params.eventData,
    });

    // PersistenceEvent'i trajectory'ye ekle
    this.trajectoryManager.addEvent(trajectory.id, event);

    return trajectory;
  }

  /**
   * Trajectory'yi replay et.
   */
  async replayTrajectory(params: {
    trajectoryId: string;
    handler: (event: PersistenceEvent) => Promise<void>;
    speed?: number;
  }): Promise<ReplayResult> {
    return this.trajectoryManager.replayTrajectory(params);
  }

  /**
   * Pipeline istatistiklerini al.
   */
  getStats(): {
    stateBackend: ReturnType<InMemoryStateBackend["getStats"]>;
    eventStore: ReturnType<TransactionalEventStore["getStats"]>;
    trajectoryManager: ReturnType<TrajectoryManager["getStats"]>;
  } {
    return {
      stateBackend: this.stateBackend.getStats(),
      eventStore: this.eventStore.getStats(),
      trajectoryManager: this.trajectoryManager.getStats(),
    };
  }
}
