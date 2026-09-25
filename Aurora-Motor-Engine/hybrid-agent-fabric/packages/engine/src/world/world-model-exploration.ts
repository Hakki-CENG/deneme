/**
 * World Model Exploration — Aurora Cognitive Runtime
 *
 * State-action-prediction-actual-surprise.
 * Exploration value calculation.
 * Prediction error tracking.
 */

import { randomUUID } from "node:crypto";

/**
 * World state.
 */
export interface WorldState {
  id: string;
  description: string;
  features: Record<string, unknown>;
  timestamp: string;
}

/**
 * Action.
 */
export interface Action {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Prediction.
 */
export interface Prediction {
  id: string;
  stateId: string;
  actionId: string;
  predictedState: WorldState;
  confidence: number;
  timestamp: string;
}

/**
 * Actual outcome.
 */
export interface ActualOutcome {
  id: string;
  predictionId: string;
  actualState: WorldState;
  success: boolean;
  timestamp: string;
}

/**
 * Surprise.
 */
export interface Surprise {
  id: string;
  predictionId: string;
  actualId: string;
  surpriseScore: number; // 0-1
  explanation: string;
  timestamp: string;
}

/**
 * Exploration value.
 */
export interface ExplorationValue {
  stateId: string;
  novelty: number; // 0-1
  uncertainty: number; // 0-1
  potential: number; // 0-1
  totalValue: number; // 0-1
}

/**
 * Prediction error.
 */
export interface PredictionError {
  id: string;
  predictionId: string;
  errorType: "state_mismatch" | "unexpected_outcome" | "confidence_miscalibration";
  errorMagnitude: number; // 0-1
  description: string;
  timestamp: string;
}

/**
 * World Model Manager
 * 
 * State-action-prediction-actual-surprise.
 */
export class WorldModelManager {
  private readonly states = new Map<string, WorldState>();
  private readonly actions = new Map<string, Action>();
  private readonly predictions = new Map<string, Prediction>();
  private readonly outcomes = new Map<string, ActualOutcome>();
  private readonly surprises = new Map<string, Surprise>();

  /**
   * State ekle.
   */
  addState(state: Omit<WorldState, "id" | "timestamp">): WorldState {
    const id = randomUUID();
    const worldState: WorldState = {
      ...state,
      id,
      timestamp: new Date().toISOString(),
    };
    this.states.set(id, worldState);
    return worldState;
  }

  /**
   * Action ekle.
   */
  addAction(action: Omit<Action, "id">): Action {
    const id = randomUUID();
    const worldAction: Action = {
      ...action,
      id,
    };
    this.actions.set(id, worldAction);
    return worldAction;
  }

  /**
   * Prediction oluştur.
   */
  createPrediction(params: {
    stateId: string;
    actionId: string;
    predictedState: Omit<WorldState, "id" | "timestamp">;
    confidence: number;
  }): Prediction {
    const id = randomUUID();
    const prediction: Prediction = {
      id,
      stateId: params.stateId,
      actionId: params.actionId,
      predictedState: {
        ...params.predictedState,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
      confidence: params.confidence,
      timestamp: new Date().toISOString(),
    };
    this.predictions.set(id, prediction);
    return prediction;
  }

  /**
   * Actual outcome kaydet.
   */
  recordOutcome(params: {
    predictionId: string;
    actualState: Omit<WorldState, "id" | "timestamp">;
    success: boolean;
  }): ActualOutcome {
    const id = randomUUID();
    const outcome: ActualOutcome = {
      id,
      predictionId: params.predictionId,
      actualState: {
        ...params.actualState,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
      success: params.success,
      timestamp: new Date().toISOString(),
    };
    this.outcomes.set(id, outcome);

    // Surprise hesapla
    const surprise = this.calculateSurprise(params.predictionId, id);
    if (surprise) {
      this.surprises.set(surprise.id, surprise);
    }

    return outcome;
  }

  /**
   * Surprise hesapla.
   */
  private calculateSurprise(predictionId: string, outcomeId: string): Surprise | null {
    const prediction = this.predictions.get(predictionId);
    const outcome = this.outcomes.get(outcomeId);
    if (!prediction || !outcome) return null;

    // State comparison
    const predictedFeatures = prediction.predictedState.features;
    const actualFeatures = outcome.actualState.features;

    let mismatchCount = 0;
    let totalFeatures = 0;

    for (const key of new Set([...Object.keys(predictedFeatures), ...Object.keys(actualFeatures)])) {
      totalFeatures++;
      if (JSON.stringify(predictedFeatures[key]) !== JSON.stringify(actualFeatures[key])) {
        mismatchCount++;
      }
    }

    const surpriseScore = totalFeatures > 0 ? mismatchCount / totalFeatures : 0;

    // An accurate prediction is not a surprise. Recording a zero-score entry
    // would flood the surprise log and make the signal meaningless — the
    // exploration loop keys off surprises to decide where to look next.
    if (surpriseScore <= 0) return null;

    return {
      id: randomUUID(),
      predictionId,
      actualId: outcomeId,
      surpriseScore,
      explanation: surpriseScore > 0.5
        ? "High surprise: significant prediction error"
        : surpriseScore > 0.2
          ? "Moderate surprise: some prediction errors"
          : "Low surprise: prediction was mostly accurate",
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * State'leri al.
   */
  getStates(): WorldState[] {
    return [...this.states.values()];
  }

  /**
   * Action'ları al.
   */
  getActions(): Action[] {
    return [...this.actions.values()];
  }

  /**
   * Prediction'ları al.
   */
  getPredictions(): Prediction[] {
    return [...this.predictions.values()];
  }

  /**
   * Outcome'ları al.
   */
  getOutcomes(): ActualOutcome[] {
    return [...this.outcomes.values()];
  }

  /**
   * Surprise'ları al.
   */
  getSurprises(): Surprise[] {
    return [...this.surprises.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalStates: number;
    totalActions: number;
    totalPredictions: number;
    totalOutcomes: number;
    totalSurprises: number;
    avgSurpriseScore: number;
    predictionAccuracy: number;
  } {
    const surprises = [...this.surprises.values()];
    const outcomes = [...this.outcomes.values()];

    return {
      totalStates: this.states.size,
      totalActions: this.actions.size,
      totalPredictions: this.predictions.size,
      totalOutcomes: outcomes.length,
      totalSurprises: surprises.length,
      avgSurpriseScore: surprises.length > 0
        ? surprises.reduce((sum, s) => sum + s.surpriseScore, 0) / surprises.length
        : 0,
      predictionAccuracy: outcomes.length > 0
        ? outcomes.filter(o => o.success).length / outcomes.length
        : 0,
    };
  }
}

/**
 * Exploration Value Calculator
 * 
 * Exploration value calculation.
 */
export class ExplorationValueCalculator {
  private readonly visitedStates = new Map<string, number>();
  private readonly stateFeatures = new Map<string, Record<string, unknown>>();

  /**
   * State'i ziyaret et.
   */
  visitState(stateId: string, features: Record<string, unknown>): void {
    const visitCount = this.visitedStates.get(stateId) ?? 0;
    this.visitedStates.set(stateId, visitCount + 1);
    this.stateFeatures.set(stateId, features);
  }

  /**
   * Exploration value hesapla.
   */
  calculateExplorationValue(stateId: string): ExplorationValue {
    const visitCount = this.visitedStates.get(stateId) ?? 0;
    const features = this.stateFeatures.get(stateId) ?? {};

    // Novelty: az ziyaret edilen state'ler daha novel
    const novelty = 1 / (1 + Math.log(1 + visitCount));

    // Uncertainty: feature'lara göre belirsizlik
    const uncertainty = this.calculateUncertainty(features);

    // Potential: novelty ve uncertainty'nin kombinasyonu
    const potential = (novelty + uncertainty) / 2;

    // Total value
    const totalValue = novelty * 0.4 + uncertainty * 0.3 + potential * 0.3;

    return {
      stateId,
      novelty,
      uncertainty,
      potential,
      totalValue,
    };
  }

  /**
   * Uncertainty hesapla.
   */
  private calculateUncertainty(features: Record<string, unknown>): number {
    // Feature sayısına göre belirsizlik
    const featureCount = Object.keys(features).length;
    return Math.min(1, featureCount / 10);
  }

  /**
   * En yüksek exploration value'lu state'leri al.
   */
  getTopExplorationStates(limit: number = 5): ExplorationValue[] {
    const values: ExplorationValue[] = [];

    for (const stateId of this.visitedStates.keys()) {
      values.push(this.calculateExplorationValue(stateId));
    }

    return values
      .sort((a, b) => b.totalValue - a.totalValue)
      .slice(0, limit);
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalVisitedStates: number;
    avgVisitCount: number;
    avgNovelty: number;
  } {
    const visitCounts = [...this.visitedStates.values()];
    return {
      totalVisitedStates: this.visitedStates.size,
      avgVisitCount: visitCounts.length > 0
        ? visitCounts.reduce((sum, c) => sum + c, 0) / visitCounts.length
        : 0,
      avgNovelty: this.getTopExplorationStates(100).reduce((sum, v) => sum + v.novelty, 0) / Math.max(1, this.visitedStates.size),
    };
  }
}

/**
 * Prediction Error Tracker
 * 
 * Prediction error tracking.
 */
export class PredictionErrorTracker {
  private readonly errors = new Map<string, PredictionError>();

  /**
   * Prediction error kaydet.
   */
  recordError(params: {
    predictionId: string;
    errorType: PredictionError["errorType"];
    errorMagnitude: number;
    description: string;
  }): PredictionError {
    const id = randomUUID();
    const error: PredictionError = {
      id,
      predictionId: params.predictionId,
      errorType: params.errorType,
      errorMagnitude: params.errorMagnitude,
      description: params.description,
      timestamp: new Date().toISOString(),
    };
    this.errors.set(id, error);
    return error;
  }

  /**
   * Prediction error'ları analiz et.
   */
  analyzeErrors(): {
    totalErrors: number;
    byType: Record<string, number>;
    avgMagnitude: number;
    recentErrors: PredictionError[];
  } {
    const errors = [...this.errors.values()];
    const byType: Record<string, number> = {};

    for (const error of errors) {
      byType[error.errorType] = (byType[error.errorType] ?? 0) + 1;
    }

    return {
      totalErrors: errors.length,
      byType,
      avgMagnitude: errors.length > 0
        ? errors.reduce((sum, e) => sum + e.errorMagnitude, 0) / errors.length
        : 0,
      recentErrors: errors.slice(-10),
    };
  }

  /**
   * Error trend'leri al.
   */
  getErrorTrends(): {
    increasing: boolean;
    decreasing: boolean;
    stable: boolean;
    trendDirection: "up" | "down" | "stable";
  } {
    const errors = [...this.errors.values()];
    if (errors.length < 2) {
      return { increasing: false, decreasing: false, stable: true, trendDirection: "stable" };
    }

    // Son 10 error'ı analiz et
    const recentErrors = errors.slice(-10);
    const firstHalf = recentErrors.slice(0, Math.floor(recentErrors.length / 2));
    const secondHalf = recentErrors.slice(Math.floor(recentErrors.length / 2));

    const firstAvg = firstHalf.reduce((sum, e) => sum + e.errorMagnitude, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, e) => sum + e.errorMagnitude, 0) / secondHalf.length;

    const diff = secondAvg - firstAvg;

    return {
      increasing: diff > 0.1,
      decreasing: diff < -0.1,
      stable: Math.abs(diff) <= 0.1,
      trendDirection: diff > 0.1 ? "up" : diff < -0.1 ? "down" : "stable",
    };
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalErrors: number;
    avgMagnitude: number;
    byType: Record<string, number>;
  } {
    const analysis = this.analyzeErrors();
    return {
      totalErrors: analysis.totalErrors,
      avgMagnitude: analysis.avgMagnitude,
      byType: analysis.byType,
    };
  }
}

/**
 * World Model Exploration Pipeline
 * 
 * State-action-prediction-actual-surprise pipeline.
 */
export class WorldModelExplorationPipeline {
  readonly worldModel: WorldModelManager;
  readonly exploration: ExplorationValueCalculator;
  readonly predictionErrors: PredictionErrorTracker;

  constructor() {
    this.worldModel = new WorldModelManager();
    this.exploration = new ExplorationValueCalculator();
    this.predictionErrors = new PredictionErrorTracker();
  }

  /**
   * Pipeline adımını çalıştır.
   */
  async executeStep(params: {
    currentState: Omit<WorldState, "id" | "timestamp">;
    action: Omit<Action, "id">;
    predictedNextState: Omit<WorldState, "id" | "timestamp">;
    confidence: number;
  }): Promise<{
    state: WorldState;
    action: Action;
    prediction: Prediction;
    explorationValue: ExplorationValue;
  }> {
    // 1. State ekle
    const state = this.worldModel.addState(params.currentState);

    // 2. Action ekle
    const action = this.worldModel.addAction(params.action);

    // 3. Prediction oluştur
    const prediction = this.worldModel.createPrediction({
      stateId: state.id,
      actionId: action.id,
      predictedState: params.predictedNextState,
      confidence: params.confidence,
    });

    // 4. Exploration value hesapla
    this.exploration.visitState(state.id, state.features);
    const explorationValue = this.exploration.calculateExplorationValue(state.id);

    return { state, action, prediction, explorationValue };
  }

  /**
   * Sonucu kaydet.
   */
  async recordResult(params: {
    predictionId: string;
    actualState: Omit<WorldState, "id" | "timestamp">;
    success: boolean;
  }): Promise<{
    outcome: ActualOutcome;
    surprise: Surprise | null;
    predictionError: PredictionError | null;
  }> {
    // 1. Outcome kaydet
    const outcome = this.worldModel.recordOutcome({
      predictionId: params.predictionId,
      actualState: params.actualState,
      success: params.success,
    });

    // 2. Surprise al
    const surprises = this.worldModel.getSurprises();
    const surprise = surprises.find(s => s.predictionId === params.predictionId) ?? null;

    // 3. Prediction error kaydet (eğer surprise yüksekse)
    let predictionError: PredictionError | null = null;
    if (surprise && surprise.surpriseScore > 0.3) {
      predictionError = this.predictionErrors.recordError({
        predictionId: params.predictionId,
        errorType: "state_mismatch",
        errorMagnitude: surprise.surpriseScore,
        description: surprise.explanation,
      });
    }

    return { outcome, surprise, predictionError };
  }

  /**
   * Pipeline istatistiklerini al.
   */
  getStats(): {
    worldModel: ReturnType<WorldModelManager["getStats"]>;
    exploration: ReturnType<ExplorationValueCalculator["getStats"]>;
    predictionErrors: ReturnType<PredictionErrorTracker["getStats"]>;
  } {
    return {
      worldModel: this.worldModel.getStats(),
      exploration: this.exploration.getStats(),
      predictionErrors: this.predictionErrors.getStats(),
    };
  }
}
