/**
 * Agent Society — Aurora Cognitive Runtime
 *
 * Reputation-based routing.
 * Multi-agent evaluation.
 */

import { randomUUID } from "node:crypto";

/**
 * Agent profile.
 */
export interface AgentProfile {
  id: string;
  name: string;
  capabilities: string[];
  reputation: number; // 0-1
  totalTasks: number;
  successfulTasks: number;
  avgResponseTime: number;
  status: "active" | "idle" | "busy" | "offline";
  createdAt: string;
  lastActiveAt: string;
}

/**
 * Reputation score.
 */
export interface ReputationScore {
  agentId: string;
  score: number; // 0-1
  factors: {
    successRate: number;
    responseTime: number;
    consistency: number;
    reliability: number;
  };
  updatedAt: string;
}

/**
 * Routing decision.
 */
export interface SocietyRoutingDecision {
  id: string;
  taskId: string;
  selectedAgent: string;
  reason: string;
  confidence: number; // 0-1
  alternatives: string[];
  timestamp: string;
}

/**
 * Evaluation result.
 */
export interface EvaluationResult {
  id: string;
  agentId: string;
  taskId: string;
  score: number; // 0-1
  metrics: {
    accuracy: number;
    completeness: number;
    efficiency: number;
    creativity: number;
  };
  feedback: string;
  timestamp: string;
}

/**
 * Swarm measurement.
 */
export interface SwarmMeasurement {
  id: string;
  taskType: string;
  agents: string[];
  collectiveScore: number; // 0-1
  individualScores: Map<string, number>;
  synergy: number; // 0-1 (collective vs sum of individuals)
  timestamp: string;
}

/**
 * Reputation Manager
 * 
 * Reputation-based routing.
 */
export class ReputationManager {
  private readonly scores = new Map<string, ReputationScore>();

  /**
   * Reputation score hesapla.
   */
  calculateReputation(agent: AgentProfile): ReputationScore {
    const successRate = agent.totalTasks > 0
      ? agent.successfulTasks / agent.totalTasks
      : 0;

    const responseTime = Math.max(0, 1 - (agent.avgResponseTime / 10000)); // 10s max
    const consistency = agent.reputation; // Mevcut reputation consistency proxy
    const reliability = agent.status === "active" ? 1 : agent.status === "idle" ? 0.8 : 0.5;

    const score = successRate * 0.4 + responseTime * 0.2 + consistency * 0.2 + reliability * 0.2;

    const reputationScore: ReputationScore = {
      agentId: agent.id,
      score,
      factors: {
        successRate,
        responseTime,
        consistency,
        reliability,
      },
      updatedAt: new Date().toISOString(),
    };

    this.scores.set(agent.id, reputationScore);
    return reputationScore;
  }

  /**
   * Reputation score'u al.
   */
  getScore(agentId: string): ReputationScore | undefined {
    return this.scores.get(agentId);
  }

  /**
   * Tüm score'ları al.
   */
  getAllScores(): ReputationScore[] {
    return [...this.scores.values()];
  }

  /**
   * En yüksek reputation'lu agent'ları al.
   */
  getTopAgents(limit: number = 5): ReputationScore[] {
    return [...this.scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalAgents: number;
    avgReputation: number;
    topReputation: number;
  } {
    const scores = [...this.scores.values()];
    return {
      totalAgents: scores.length,
      avgReputation: scores.length > 0
        ? scores.reduce((sum, s) => sum + s.score, 0) / scores.length
        : 0,
      topReputation: scores.length > 0
        ? Math.max(...scores.map(s => s.score))
        : 0,
    };
  }
}

/**
 * Society Router
 * 
 * Reputation-based routing.
 */
export class SocietyRouter {
  private readonly routingHistory = new Map<string, SocietyRoutingDecision>();

  /**
   * Task için en iyi agent'ı seç.
   */
  selectAgent(params: {
    taskId: string;
    taskType: string;
    requirements: {
      capabilities: string[];
      minReputation?: number;
      maxResponseTime?: number;
    };
    agents: AgentProfile[];
    reputationScores: Map<string, ReputationScore>;
  }): SocietyRoutingDecision {
    const candidates = params.agents.filter(agent => {
      // Capability kontrolü
      const hasCapabilities = params.requirements.capabilities.every(cap =>
        agent.capabilities.includes(cap)
      );
      if (!hasCapabilities) return false;

      // Reputation kontrolü
      const reputation = params.reputationScores.get(agent.id);
      if (params.requirements.minReputation && (!reputation || reputation.score < params.requirements.minReputation)) {
        return false;
      }

      // Response time kontrolü
      if (params.requirements.maxResponseTime && agent.avgResponseTime > params.requirements.maxResponseTime) {
        return false;
      }

      // Status kontrolü
      if (agent.status === "offline") return false;

      return true;
    });

    // En iyi agent'ı seç (reputation * 0.7 + capability match * 0.3)
    let bestAgent: AgentProfile | null = null;
    let bestScore = -1;

    for (const agent of candidates) {
      const reputation = params.reputationScores.get(agent.id)?.score ?? 0;
      const capabilityMatch = params.requirements.capabilities.filter(cap =>
        agent.capabilities.includes(cap)
      ).length / params.requirements.capabilities.length;

      const score = reputation * 0.7 + capabilityMatch * 0.3;

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    }

    const decision: SocietyRoutingDecision = {
      id: randomUUID(),
      taskId: params.taskId,
      selectedAgent: bestAgent?.id ?? "none",
      reason: bestAgent
        ? `Selected ${bestAgent.name} with score ${bestScore.toFixed(2)}`
        : "No suitable agent found",
      confidence: bestScore,
      alternatives: candidates
        .filter(a => a.id !== bestAgent?.id)
        .map(a => a.id)
        .slice(0, 3),
      timestamp: new Date().toISOString(),
    };

    this.routingHistory.set(decision.id, decision);
    return decision;
  }

  /**
   * Routing history'yi al.
   */
  getRoutingHistory(): SocietyRoutingDecision[] {
    return [...this.routingHistory.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalDecisions: number;
    avgConfidence: number;
  } {
    const decisions = [...this.routingHistory.values()];
    return {
      totalDecisions: decisions.length,
      avgConfidence: decisions.length > 0
        ? decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length
        : 0,
    };
  }
}

/**
 * Multi-Agent Evaluator
 * 
 * Multi-agent evaluation.
 */
export class MultiAgentEvaluator {
  private readonly evaluations = new Map<string, EvaluationResult>();

  /**
   * Agent evaluation yap.
   */
  async evaluateAgent(params: {
    agentId: string;
    taskId: string;
    taskResult: unknown;
    evaluate: (result: unknown) => Promise<{
      accuracy: number;
      completeness: number;
      efficiency: number;
      creativity: number;
    }>;
  }): Promise<EvaluationResult> {
    const metrics = await params.evaluate(params.taskResult);

    const score = (
      metrics.accuracy * 0.3 +
      metrics.completeness * 0.3 +
      metrics.efficiency * 0.2 +
      metrics.creativity * 0.2
    );

    const result: EvaluationResult = {
      id: randomUUID(),
      agentId: params.agentId,
      taskId: params.taskId,
      score,
      metrics,
      feedback: `Score: ${score.toFixed(2)} - Accuracy: ${metrics.accuracy.toFixed(2)}, Completeness: ${metrics.completeness.toFixed(2)}`,
      timestamp: new Date().toISOString(),
    };

    this.evaluations.set(result.id, result);
    return result;
  }

  /**
   * Evaluation'ları al.
   */
  getEvaluations(): EvaluationResult[] {
    return [...this.evaluations.values()];
  }

  /**
   * Agent bazlı evaluation'ları al.
   */
  getEvaluationsByAgent(agentId: string): EvaluationResult[] {
    return [...this.evaluations.values()].filter(e => e.agentId === agentId);
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalEvaluations: number;
    avgScore: number;
    avgAccuracy: number;
    avgCompleteness: number;
  } {
    const evaluations = [...this.evaluations.values()];
    return {
      totalEvaluations: evaluations.length,
      avgScore: evaluations.length > 0
        ? evaluations.reduce((sum, e) => sum + e.score, 0) / evaluations.length
        : 0,
      avgAccuracy: evaluations.length > 0
        ? evaluations.reduce((sum, e) => sum + e.metrics.accuracy, 0) / evaluations.length
        : 0,
      avgCompleteness: evaluations.length > 0
        ? evaluations.reduce((sum, e) => sum + e.metrics.completeness, 0) / evaluations.length
        : 0,
    };
  }
}

/**
 * Swarm Measurement
 * 
 * Swarm measurement.
 */
export class SwarmMeasurementManager {
  private readonly measurements = new Map<string, SwarmMeasurement>();

  /**
   * Swarm measurement yap.
   */
  measureSwarm(params: {
    taskType: string;
    agents: string[];
    individualScores: Map<string, number>;
  }): SwarmMeasurement {
    const scores = [...params.individualScores.values()];
    const collectiveScore = scores.length > 0
      ? scores.reduce((sum, s) => sum + s, 0) / scores.length
      : 0;

    // Synergy: collective vs expected (sum of individuals / count)
    const expectedScore = scores.length > 0
      ? scores.reduce((sum, s) => sum + s, 0) / scores.length
      : 0;
    const synergy = expectedScore > 0 ? collectiveScore / expectedScore : 1;

    const measurement: SwarmMeasurement = {
      id: randomUUID(),
      taskType: params.taskType,
      agents: params.agents,
      collectiveScore,
      individualScores: params.individualScores,
      synergy,
      timestamp: new Date().toISOString(),
    };

    this.measurements.set(measurement.id, measurement);
    return measurement;
  }

  /**
   * Measurement'ları al.
   */
  getMeasurements(): SwarmMeasurement[] {
    return [...this.measurements.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalMeasurements: number;
    avgCollectiveScore: number;
    avgSynergy: number;
  } {
    const measurements = [...this.measurements.values()];
    return {
      totalMeasurements: measurements.length,
      avgCollectiveScore: measurements.length > 0
        ? measurements.reduce((sum, m) => sum + m.collectiveScore, 0) / measurements.length
        : 0,
      avgSynergy: measurements.length > 0
        ? measurements.reduce((sum, m) => sum + m.synergy, 0) / measurements.length
        : 0,
    };
  }
}

/**
 * Agent Society Pipeline
 * 
 * Reputation-based routing + multi-agent evaluation.
 */
export class AgentSocietyPipeline {
  readonly reputationManager: ReputationManager;
  readonly societyRouter: SocietyRouter;
  readonly evaluator: MultiAgentEvaluator;
  readonly swarmMeasurement: SwarmMeasurementManager;

  private readonly agents = new Map<string, AgentProfile>();

  constructor() {
    this.reputationManager = new ReputationManager();
    this.societyRouter = new SocietyRouter();
    this.evaluator = new MultiAgentEvaluator();
    this.swarmMeasurement = new SwarmMeasurementManager();
  }

  /**
   * Agent ekle.
   */
  addAgent(params: {
    name: string;
    capabilities: string[];
    status?: AgentProfile["status"];
  }): AgentProfile {
    const id = randomUUID();
    const agent: AgentProfile = {
      id,
      name: params.name,
      capabilities: params.capabilities,
      reputation: 0.5,
      totalTasks: 0,
      successfulTasks: 0,
      avgResponseTime: 0,
      status: params.status ?? "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    this.agents.set(id, agent);

    // Reputation hesapla
    this.reputationManager.calculateReputation(agent);

    return agent;
  }

  /**
   * Agent'ları al.
   */
  getAgents(): AgentProfile[] {
    return [...this.agents.values()];
  }

  /**
   * Task için agent seç.
   */
  selectAgentForTask(params: {
    taskId: string;
    taskType: string;
    requirements: {
      capabilities: string[];
      minReputation?: number;
      maxResponseTime?: number;
    };
  }): SocietyRoutingDecision {
    return this.societyRouter.selectAgent({
      ...params,
      agents: [...this.agents.values()],
      reputationScores: new Map(
        this.reputationManager.getAllScores().map(s => [s.agentId, s])
      ),
    });
  }

  /**
   * Agent'ı değerlendir.
   */
  /**
   * Evaluates an agent's performance on a task.
   *
   * The scoring function is a required parameter, and that is the fix rather
   * than a stylistic choice. This method used to supply its own:
   *
   *     evaluate: async (result) => ({
   *       accuracy: 0.85, completeness: 0.90, efficiency: 0.80, creativity: 0.75,
   *     })
   *
   * The same four numbers for every agent, every task, every outcome -- `result`
   * was accepted and never read. The underlying `MultiAgentEvaluator` does real
   * weighted scoring on whatever it is handed, so the fabricated constants went
   * straight into the reputation manager as if they had been measured. Making
   * the function required means a caller cannot get an evaluation without
   * supplying the judgement behind it.
   */
  async evaluateAgent(params: {
    agentId: string;
    taskId: string;
    taskResult: unknown;
    evaluate: (result: unknown) => Promise<{
      accuracy: number;
      completeness: number;
      efficiency: number;
      creativity: number;
    }>;
  }): Promise<EvaluationResult> {
    return this.evaluator.evaluateAgent(params);
  }

  /**
   * Swarm measurement yap.
   */
  measureSwarm(params: {
    taskType: string;
    agentIds: string[];
  }): SwarmMeasurement {
    const individualScores = new Map<string, number>();
    for (const agentId of params.agentIds) {
      const agent = this.agents.get(agentId);
      if (agent) {
        individualScores.set(agentId, agent.reputation);
      }
    }

    return this.swarmMeasurement.measureSwarm({
      taskType: params.taskType,
      agents: params.agentIds,
      individualScores,
    });
  }

  /**
   * Pipeline istatistiklerini al.
   */
  getStats(): {
    agents: number;
    reputation: ReturnType<ReputationManager["getStats"]>;
    router: ReturnType<SocietyRouter["getStats"]>;
    evaluator: ReturnType<MultiAgentEvaluator["getStats"]>;
    swarm: ReturnType<SwarmMeasurementManager["getStats"]>;
  } {
    return {
      agents: this.agents.size,
      reputation: this.reputationManager.getStats(),
      router: this.societyRouter.getStats(),
      evaluator: this.evaluator.getStats(),
      swarm: this.swarmMeasurement.getStats(),
    };
  }
}
