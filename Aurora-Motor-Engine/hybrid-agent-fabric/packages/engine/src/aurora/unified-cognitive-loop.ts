/**
 * Unified Cognitive Loop — Aurora Cognitive Runtime
 *
 * Meta Controller'ın run() methodunu unified bir cognitive loop'a çevirir.
 * Tüm servisler CognitiveState'i paylaşır.
 * EventBus üzerinden otomatik mode transitions.
 * Failure recovery loop'u.
 */

import { randomUUID } from "node:crypto";
import type { EventBus, AuroraEvent } from "./event-bus.js";
import type { CognitiveState, CognitiveMode, CognitiveStateSnapshot } from "./cognitive-state.js";
import type { MetaControllerService, RunResult, SubsystemExecutors } from "./meta-controller.js";

export interface CognitiveLoopConfig {
  maxRetries: number;
  recoveryTimeoutMs: number;
  enableAutoRecovery: boolean;
  enableEventDrivenTransitions: boolean;
}

export interface CognitiveLoopResult {
  runResult: RunResult;
  cognitiveStateHistory: Array<{ timestamp: number; mode: CognitiveMode; reason: string }>;
  eventsEmitted: AuroraEvent[];
  recoveryAttempts: number;
  finalState: CognitiveStateSnapshot;
}

export class UnifiedCognitiveLoop {
  private config: CognitiveLoopConfig;
  private eventsEmitted: AuroraEvent[] = [];
  private recoveryAttempts = 0;

  constructor(
    private metaController: MetaControllerService,
    private cognitiveState: CognitiveState,
    private eventBus: EventBus,
    config?: Partial<CognitiveLoopConfig>
  ) {
    this.config = {
      maxRetries: 3,
      recoveryTimeoutMs: 30000,
      enableAutoRecovery: true,
      enableEventDrivenTransitions: true,
      ...config,
    };
  }

  /**
   * Unified cognitive loop — tüm sistemi orkestre eder.
   *
   * 1. Görevi alır
   * 2. CognitiveState'i günceller
   * 3. EventBus üzerinden bildirim gönderir
   * 4. Meta Controller'ı çalıştırır
   * 5. Hata olursa recovery dener
   * 6. Sonucu kaydeder
   */
  async execute(
    tenantId: string,
    taskDescription: string,
    executors: SubsystemExecutors
  ): Promise<CognitiveLoopResult> {
    const traceId = `loop-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const stateHistory: Array<{ timestamp: number; mode: CognitiveMode; reason: string }> = [];
    this.eventsEmitted = [];
    this.recoveryAttempts = 0;
    // This run's own slot. Without it every failure the loop recorded went into
    // one global list with nothing tying it to a task, so "why did this run
    // fail?" had no answer and `activeGoal` described no one in particular.
    // `traceId` is the identity the loop already reports in its events, so a
    // slot keyed by it can be correlated with them.
    this.cognitiveState.beginTask(traceId, tenantId);

    // 1. Görev başladı — EventBus
    await this.emitEvent("task.received", "UnifiedCognitiveLoop", {
      taskDescription: taskDescription.slice(0, 200),
      tenantId,
      traceId,
    });

    // 2. CognitiveState'i observing moduna al
    this.cognitiveState.setMode("observing", `New task: ${taskDescription.slice(0, 50)}`);
    stateHistory.push({ timestamp: Date.now(), mode: "observing", reason: "Task received" });

    // 3. Meta Controller'ı çalıştır
    let runResult: RunResult;
    try {
      runResult = await this.metaController.run(tenantId, taskDescription, executors);
    } catch (error) {
      // Hata durumunda recovery
      if (this.config.enableAutoRecovery) {
        runResult = await this.handleFailure(tenantId, taskDescription, executors, error as Error, traceId);
      } else {
        throw error;
      }
    }

    // 4. CognitiveState'i sonuca göre güncelle
    this.updateStateFromResult(runResult, stateHistory, traceId);

    // 5. Sonuç event'ı
    await this.emitEvent(
      runResult.outcome === "success" ? "task.completed" : "task.failed",
      "UnifiedCognitiveLoop",
      {
        traceId,
        outcome: runResult.outcome,
        durationMs: runResult.totalDurationMs,
        subsystemsUsed: runResult.subsystemsUsed.length,
      }
    );

    // 6. Final state snapshot
    const finalState = this.cognitiveState.snapshot();
    // Taken before endTask: the snapshot is what the run looked like while it
    // was the focused task, which is what the caller asked for.
    this.cognitiveState.endTask(traceId);

    return {
      runResult,
      cognitiveStateHistory: stateHistory,
      eventsEmitted: this.eventsEmitted,
      recoveryAttempts: this.recoveryAttempts,
      finalState,
    };
  }

  /**
   * Hata durumunda recovery dener.
   */
  private async handleFailure(
    tenantId: string,
    taskDescription: string,
    executors: SubsystemExecutors,
    error: Error,
    traceId: string
  ): Promise<RunResult> {
    this.recoveryAttempts++;

    // Recovery moduna geç
    this.cognitiveState.setMode("recovering", `Error: ${error.message}`);
    await this.emitEvent("task.recovery.started", "UnifiedCognitiveLoop", {
      traceId,
      error: error.message,
      attempt: this.recoveryAttempts,
    });

    // Retry
    while (this.recoveryAttempts <= this.config.maxRetries) {
      try {
        const result = await this.metaController.run(tenantId, taskDescription, executors);
        
        // Başarılı recovery
        await this.emitEvent("task.recovery.succeeded", "UnifiedCognitiveLoop", {
          traceId,
          attempt: this.recoveryAttempts,
        });
        
        return result;
      } catch (retryError) {
        this.recoveryAttempts++;
        
        if (this.recoveryAttempts > this.config.maxRetries) {
          // Max retry aşıldı
          await this.emitEvent("task.recovery.failed", "UnifiedCognitiveLoop", {
            traceId,
            attempt: this.recoveryAttempts,
            error: (retryError as Error).message,
          });

          // Failure olarak kaydet — bu çalıştırmanın slotuna, böylece görevin
          // kendi kaydı neden başarısız olduğunu söylüyor.
          this.cognitiveState.recordFailureFor(traceId, {
            type: "recovery_exhausted",
            description: `Failed after ${this.config.maxRetries} retries: ${(retryError as Error).message}`,
            subsystem: "UnifiedCognitiveLoop",
            timestamp: Date.now(),
            recoveryAttempted: true,
          });

          // Failure result döndür
          return {
            traceId,
            profile: { id: "failed", tenantId, taskDescription, complexity: "moderate", estimatedTokens: 0, estimatedDurationMs: 0, requiredSubsystems: [], parallelizable: false, riskLevel: "high", userPatience: "normal", createdAt: new Date().toISOString() },
            plan: { id: "failed", profileId: "failed", phases: [], totalEstimatedMs: 0, totalEstimatedTokens: 0, parallelGroups: [], earlyExitConditions: [], fallbackPlan: "none", createdAt: new Date().toISOString() },
            phaseResults: [],
            decision: { id: randomUUID(), tenantId, taskId: "failed", profile: {} as any, plan: {} as any, actualDurationMs: 0, actualTokensUsed: 0, actualSubsystemsUsed: [], outcome: "failure", efficiency: 0, lessonsForMeta: [`Recovery failed: ${(retryError as Error).message}`], createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
            totalDurationMs: 0,
            outcome: "failure",
            subsystemsUsed: [],
          };
        }

        // Bir sonraki retry için bekle
        await new Promise(resolve => setTimeout(resolve, 1000 * this.recoveryAttempts));
      }
    }

    // Bu noktaya ulaşılmamalı ama güvenlik için
    throw new Error("Recovery failed unexpectedly");
  }

  /**
   * Run sonucuna göre CognitiveState'i güncelle.
   */
  private updateStateFromResult(
    result: RunResult,
    stateHistory: Array<{ timestamp: number; mode: CognitiveMode; reason: string }>,
    traceId: string,
  ): void {
    const mode = this.outcomeToMode(result.outcome);
    this.cognitiveState.setMode(mode, `Task ${result.outcome} in ${result.totalDurationMs}ms`);
    stateHistory.push({ timestamp: Date.now(), mode, reason: `Outcome: ${result.outcome}` });

    // Başarı oranını güncelle
    this.cognitiveState.updateSuccessRate(result.outcome === "success");

    // Kaynak bütçesini güncelle
    this.cognitiveState.updateBudget({
      tokensUsed: result.decision.actualTokensUsed,
      timeElapsedMs: result.totalDurationMs,
    });

    // Subsystem sayılarını güncelle
    this.cognitiveState.setActiveCounts(0, result.subsystemsUsed.length);

    // Hata durumunda failure kaydet
    if (result.outcome === "failure" || result.outcome === "timed_out") {
      this.cognitiveState.recordFailureFor(traceId, {
        type: result.outcome,
        description: `Task ${result.outcome}: ${result.phaseResults.map(p => p.phaseName).join(" → ")}`,
        subsystem: "UnifiedCognitiveLoop",
        timestamp: Date.now(),
        recoveryAttempted: this.recoveryAttempts > 0,
      });
    }

    // Uncertainty güncelle
    if (result.outcome === "partial") {
      this.cognitiveState.setUncertainty(0.5);
    } else if (result.outcome === "failure") {
      this.cognitiveState.setUncertainty(0.8);
    } else if (result.outcome === "success") {
      this.cognitiveState.setUncertainty(0.1);
    }
  }

  /**
   * Outcome'dan CognitiveMode'a çevir.
   */
  private outcomeToMode(outcome: string): CognitiveMode {
    switch (outcome) {
      case "success": return "idle";
      case "failure": return "recovering";
      case "partial": return "reasoning";
      case "skipped": return "idle";
      case "timed_out": return "recovering";
      case "cancelled": return "idle";
      case "blocked": return "idle";
      default: return "idle";
    }
  }

  /**
   * EventBus'a event emit et.
   */
  private async emitEvent(
    type: string,
    source: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const event = await this.eventBus.emit(type, source, payload, {
      severity: type.includes("failed") || type.includes("error") ? "critical" : "info",
      traceId: payload.traceId as string,
    });
    this.eventsEmitted.push(event);
  }

  /**
   * Mevcut CognitiveState'i al.
   */
  getCurrentState(): CognitiveStateSnapshot {
    return this.cognitiveState.snapshot();
  }

  /**
   * Config'i güncelle.
   */
  updateConfig(config: Partial<CognitiveLoopConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * Recovery attempts sayısını al.
   */
  getRecoveryAttempts(): number {
    return this.recoveryAttempts;
  }

  /**
   * Emit edilen event'ları al.
   */
  getEmittedEvents(): AuroraEvent[] {
    return [...this.eventsEmitted];
  }
}
