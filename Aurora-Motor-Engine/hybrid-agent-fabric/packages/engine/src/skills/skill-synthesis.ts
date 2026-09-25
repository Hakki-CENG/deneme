/**
 * Skill Synthesis — Aurora Cognitive Runtime
 *
 * Multi-capability skills.
 * Trajectory mining → skill candidates.
 * Parameterize → verify → eval.
 */

import { randomUUID } from "node:crypto";

import { SandboxExecutor } from "../capabilities/capability-synthesis.js";

/**
 * Skill status.
 */
/**
 * Skill lifecycle.
 *
 * `structurally_valid` exists because `verifySkill()` only inspects the
 * definition — name, description, steps, parameter names. That is a real
 * check, but it is not evidence the skill *works*; nothing is executed. Using
 * `verified` for it would let an unrun skill be read as a proven one by every
 * downstream consumer of that word.
 *
 * `verified` is reserved for a skill that ran against test cases and passed:
 * see `evaluateSkill()`.
 */
export type SkillStatus =
  | "draft"
  | "testing"
  | "structurally_valid"
  | "verified"
  | "deprecated";

/**
 * Order-insensitive structural comparison used for skill output assertions.
 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEquals(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      deepEquals(left[key], right[key])
  );
}

/**
 * Bounded, throw-free stringify for diagnostic messages.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Result of executing a skill against one input.
 */
export interface SkillExecutionOutcome {
  readonly success: boolean;
  readonly output?: unknown | undefined;
  readonly error?: string | undefined;
  readonly stepsRun: number;
  readonly durationMs: number;
}

/**
 * Executes skill definitions for real.
 *
 * Each step's `capabilityId` is resolved against a registry of executable
 * capability bodies; the body runs inside the worker-thread sandbox. A skill
 * whose steps cannot be resolved fails loudly rather than reporting success.
 */
export class SkillExecutor {
  private readonly capabilityCode = new Map<string, string>();
  private readonly sandbox: SandboxExecutor;

  constructor(options?: {
    sandbox?: SandboxExecutor | undefined;
    timeoutMs?: number | undefined;
  }) {
    this.sandbox = options?.sandbox ?? new SandboxExecutor({
      defaultTimeoutMs: options?.timeoutMs ?? 5000,
    });
  }

  /**
   * Bir capability için çalıştırılabilir gövde kaydet.
   */
  registerCapability(capabilityId: string, code: string): void {
    this.capabilityCode.set(capabilityId, code);
  }

  hasCapability(capabilityId: string): boolean {
    return this.capabilityCode.has(capabilityId);
  }

  /**
   * Skill'i sırayla çalıştır; her adımın çıktısı bir sonrakine beslenir.
   */
  async runSkill(
    skill: SkillDefinition,
    input: Record<string, unknown>
  ): Promise<SkillExecutionOutcome> {
    const startedAt = Date.now();

    if (skill.steps.length === 0) {
      return {
        success: false,
        error: "skill has no executable steps",
        stepsRun: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    let current: unknown = input;
    let stepsRun = 0;

    for (const step of skill.steps) {
      const code = this.capabilityCode.get(step.capabilityId);

      if (!code) {
        if (step.optional) continue;
        return {
          success: false,
          error: `capability not executable: ${step.capabilityId} (step "${step.name}")`,
          stepsRun,
          durationMs: Date.now() - startedAt,
        };
      }

      const sandboxId = this.sandbox.createSandbox(`skill-${skill.id}-${step.id}`);
      const result = await this.sandbox.executeInSandbox(sandboxId, code, current);
      stepsRun += 1;

      if (!result.success) {
        if (step.optional) continue;
        return {
          success: false,
          error: `step "${step.name}" failed: ${result.error ?? "unknown error"}`,
          stepsRun,
          durationMs: Date.now() - startedAt,
        };
      }

      current = result.output;
    }

    return {
      success: true,
      output: current,
      stepsRun,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Skill category.
 */
export type SkillCategory = "coding" | "research" | "analysis" | "communication" | "automation" | "other";

/**
 * Skill definition.
 */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  status: SkillStatus;
  version: string;
  capabilities: string[];
  parameters: SkillParameter[];
  steps: SkillStep[];
  examples: SkillExample[];
  metrics: SkillMetrics;
  createdAt: string;
  updatedAt: string;
}

/**
 * Skill parameter.
 */
export interface SkillParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required: boolean;
  defaultValue?: unknown;
}

/**
 * Skill step.
 */
export interface SkillStep {
  id: string;
  name: string;
  description: string;
  capabilityId: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  optional: boolean;
}

/**
 * Skill example.
 */
export interface SkillExample {
  id: string;
  input: Record<string, unknown>;
  expectedOutput: Record<string, unknown>;
  description: string;
}

/**
 * Skill metrics.
 */
export interface SkillMetrics {
  executionCount: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  lastExecutedAt?: string;
}

/**
 * Trajectory event.
 */
export interface TrajectoryEvent {
  id: string;
  type: "action" | "observation" | "thought" | "error";
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Skill synthesis candidate (for trajectory mining).
 */
export interface SkillSynthesisCandidate {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  trajectoryIds: string[];
  confidence: number;
  extractedAt: string;
}

/**
 * Skill Library Manager
 * 
 * Multi-capability skills.
 */
export class SkillLibraryManager {
  private readonly skills = new Map<string, SkillDefinition>();

  /**
   * Skill ekle.
   */
  addSkill(skill: Omit<SkillDefinition, "id" | "metrics" | "createdAt" | "updatedAt">): SkillDefinition {
    const id = randomUUID();
    const now = new Date().toISOString();

    const definition: SkillDefinition = {
      ...skill,
      id,
      metrics: {
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        avgDurationMs: 0,
      },
      createdAt: now,
      updatedAt: now,
    };

    this.skills.set(id, definition);
    return definition;
  }

  /**
   * Skill güncelle.
   */
  updateSkill(skillId: string, updates: Partial<SkillDefinition>): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) return false;

    Object.assign(skill, updates, { updatedAt: new Date().toISOString() });
    return true;
  }

  /**
   * Skill sil.
   */
  removeSkill(skillId: string): boolean {
    return this.skills.delete(skillId);
  }

  /**
   * Skill al.
   */
  getSkill(skillId: string): SkillDefinition | undefined {
    return this.skills.get(skillId);
  }

  /**
   * Tüm skill'leri al.
   */
  getSkills(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  /**
   * Kategoriye göre skill'leri al.
   */
  getSkillsByCategory(category: SkillCategory): SkillDefinition[] {
    return [...this.skills.values()].filter(s => s.category === category);
  }

  /**
   * Status'a göre skill'leri al.
   */
  getSkillsByStatus(status: SkillStatus): SkillDefinition[] {
    return [...this.skills.values()].filter(s => s.status === status);
  }

  /**
   * Skill execution sonucunu kaydet.
   */
  recordExecution(skillId: string, success: boolean, durationMs: number): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;

    skill.metrics.executionCount++;
    if (success) skill.metrics.successCount++;
    else skill.metrics.failureCount++;
    skill.metrics.avgDurationMs = (skill.metrics.avgDurationMs * (skill.metrics.executionCount - 1) + durationMs) / skill.metrics.executionCount;
    skill.metrics.lastExecutedAt = new Date().toISOString();
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalSkills: number;
    byCategory: Record<string, number>;
    byStatus: Record<string, number>;
    totalExecutions: number;
    successRate: number;
  } {
    const skills = [...this.skills.values()];
    const byCategory: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let totalExecutions = 0;
    let totalSuccess = 0;

    for (const skill of skills) {
      byCategory[skill.category] = (byCategory[skill.category] ?? 0) + 1;
      byStatus[skill.status] = (byStatus[skill.status] ?? 0) + 1;
      totalExecutions += skill.metrics.executionCount;
      totalSuccess += skill.metrics.successCount;
    }

    return {
      totalSkills: skills.length,
      byCategory,
      byStatus,
      totalExecutions,
      successRate: totalExecutions > 0 ? totalSuccess / totalExecutions : 0,
    };
  }
}

/**
 * Trajectory Miner
 * 
 * Trajectory mining → skill candidates.
 */
export class TrajectoryMiner {
  private readonly trajectories = new Map<string, TrajectoryEvent[]>();
  private readonly candidates = new Map<string, SkillSynthesisCandidate>();

  /**
   * Trajectory ekle.
   */
  addTrajectory(events: TrajectoryEvent[]): string {
    const id = randomUUID();
    this.trajectories.set(id, events);
    return id;
  }

  /**
   * A recorded trajectory by id, or `undefined` if it is not (or no longer)
   * held.
   *
   * Skill synthesis needs this: a candidate only carries `trajectoryIds`, and
   * without a way back to the events the synthesizer could not turn the mined
   * action sequence into steps, so every synthesized skill was created with an
   * empty `steps` array and `verifySkill()` -- which requires at least one
   * step -- rejected all of them.
   */
  getTrajectory(id: string): readonly TrajectoryEvent[] | undefined {
    return this.trajectories.get(id);
  }

  /**
   * Trajectory'lerden skill candidate'ları çıkar.
   */
  mineCandidates(options?: {
    minEvents?: number;
    minConfidence?: number;
  }): SkillSynthesisCandidate[] {
    const minEvents = options?.minEvents ?? 3;
    const minConfidence = options?.minConfidence ?? 0.5;
    const candidates: SkillSynthesisCandidate[] = [];

    for (const [trajectoryId, events] of this.trajectories) {
      if (events.length < minEvents) continue;

      // Pattern detection
      const patterns = this.detectPatterns(events);
      
      for (const pattern of patterns) {
        if (pattern.confidence >= minConfidence) {
          const candidate: SkillSynthesisCandidate = {
            id: randomUUID(),
            name: pattern.name,
            description: pattern.description,
            category: pattern.category,
            trajectoryIds: [trajectoryId],
            confidence: pattern.confidence,
            extractedAt: new Date().toISOString(),
          };

          candidates.push(candidate);
          this.candidates.set(candidate.id, candidate);
        }
      }
    }

    return candidates;
  }

  /**
   * Pattern detection.
   */
  private detectPatterns(events: TrajectoryEvent[]): Array<{
    name: string;
    description: string;
    category: SkillCategory;
    confidence: number;
  }> {
    const patterns: Array<{
      name: string;
      description: string;
      category: SkillCategory;
      confidence: number;
    }> = [];

    // Action sequence detection
    const actions = events.filter(e => e.type === "action");
    if (actions.length >= 2) {
      const actionSequence = actions.map(a => a.content).join(" → ");
      patterns.push({
        name: `Action Sequence: ${actionSequence.slice(0, 50)}`,
        description: `Detected action sequence: ${actionSequence}`,
        category: "automation",
        confidence: Math.min(1, actions.length / 5),
      });
    }

    // Error recovery detection
    const errors = events.filter(e => e.type === "error");
    const recoveries = events.filter((e, i) => {
      if (e.type !== "action") return false;
      const prevError = events.slice(0, i).reverse().find(prev => prev.type === "error");
      return prevError !== undefined;
    });

    if (errors.length > 0 && recoveries.length > 0) {
      patterns.push({
        name: "Error Recovery Pattern",
        description: `Detected ${recoveries.length} error recovery actions`,
        category: "automation",
        confidence: Math.min(1, recoveries.length / errors.length),
      });
    }

    // Thought → Action pattern
    const thoughts = events.filter(e => e.type === "thought");
    if (thoughts.length > 0 && actions.length > 0) {
      patterns.push({
        name: "Thought-Action Pattern",
        description: `Detected ${thoughts.length} thoughts leading to ${actions.length} actions`,
        category: "analysis",
        confidence: Math.min(1, (thoughts.length + actions.length) / 10),
      });
    }

    return patterns;
  }

  /**
   * Candidate'ları al.
   */
  getCandidates(): SkillSynthesisCandidate[] {
    return [...this.candidates.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalTrajectories: number;
    totalCandidates: number;
    avgConfidence: number;
  } {
    const candidates = [...this.candidates.values()];
    return {
      totalTrajectories: this.trajectories.size,
      totalCandidates: candidates.length,
      avgConfidence: candidates.length > 0 ? candidates.reduce((sum, c) => sum + c.confidence, 0) / candidates.length : 0,
    };
  }
}

/**
 * Skill Synthesizer
 * 
 * Parameterize → verify → eval.
 */
export class SkillSynthesizer {
  readonly executor: SkillExecutor;

  constructor(
    private skillLibrary: SkillLibraryManager,
    private trajectoryMiner: TrajectoryMiner,
    executor?: SkillExecutor
  ) {
    this.executor = executor ?? new SkillExecutor();
  }

  /**
   * Candidate'dan skill oluştur.
   */
  synthesizeFromCandidate(candidate: SkillSynthesisCandidate): SkillDefinition | null {
    // Build the steps from the action sequence the candidate was mined from.
    //
    // This used to be a hardcoded empty array, which made the whole skill
    // learning chain dead on arrival: `verifySkill()` requires
    // `steps.length > 0`, so every synthesized skill failed structural
    // verification, nothing ever reached `structurally_valid`, the promotion
    // gate never had a skill to record evidence against, and self-improvement
    // had no baseline to challenge. Measured before the fix: 4 trajectories in,
    // 4 candidates out, 4 skills synthesized, 0 verified.
    //
    // The actions observed in the trajectory are the steps. `capabilityId` is
    // "unbound" rather than a guessed capability: the trajectory records what
    // was done, not which capability did it, and inventing one would let a
    // synthesized skill claim an execution path nobody bound it to.
    const actions = (candidate.trajectoryIds ?? [])
      .map((trajectoryId) => this.trajectoryMiner.getTrajectory(trajectoryId))
      .filter((trajectory): trajectory is readonly TrajectoryEvent[] =>
        Array.isArray(trajectory),
      )
      .flatMap((trajectory) => trajectory.filter((event) => event.type === "action"));

    const steps: SkillStep[] = actions.map((event, index) => ({
      id: `${candidate.id}:step:${index}`,
      name: event.content,
      description: event.content,
      capabilityId: String(event.metadata?.capabilityId ?? "unbound"),
      input: (event.metadata?.input as Record<string, unknown> | undefined) ?? {},
      output: {},
      optional: false,
    }));

    // Skill definition oluştur
    const skill = this.skillLibrary.addSkill({
      name: candidate.name,
      description: candidate.description,
      category: candidate.category,
      status: "draft",
      version: "1.0.0",
      capabilities: [],
      parameters: [],
      steps,
      examples: [],
    });

    return skill;
  }

  /**
   * Skill'i parametrize et.
   */
  parameterizeSkill(skillId: string, parameters: SkillParameter[]): boolean {
    const skill = this.skillLibrary.getSkill(skillId);
    if (!skill) return false;

    skill.parameters = parameters;
    skill.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Skill'i verify et.
   */
  verifySkill(skillId: string): boolean {
    const skill = this.skillLibrary.getSkill(skillId);
    if (!skill) return false;

    // Verification checks
    const checks = [
      skill.name.length > 0,
      skill.description.length > 0,
      skill.steps.length > 0,
      skill.parameters.every(p => p.name.length > 0),
    ];

    const allPassed = checks.every(Boolean);
    if (allPassed) {
      // Structure only. The skill has not been run, so it cannot be called
      // verified — `evaluateSkill()` is what earns that word.
      skill.status = "structurally_valid";
      skill.updatedAt = new Date().toISOString();
    }

    return allPassed;
  }

  /**
   * Skill'i eval et.
   */
  async evaluateSkill(skillId: string, testCases: Array<{
    input: Record<string, unknown>;
    expectedOutput: Record<string, unknown>;
  }>): Promise<{
    passed: number;
    failed: number;
    successRate: number;
    failures: Array<{ index: number; reason: string }>;
  }> {
    const skill = this.skillLibrary.getSkill(skillId);
    if (!skill) {
      return {
        passed: 0,
        failed: testCases.length,
        successRate: 0,
        failures: testCases.map((_, index) => ({
          index,
          reason: `Skill not found: ${skillId}`,
        })),
      };
    }

    let passed = 0;
    let failed = 0;
    const failures: Array<{ index: number; reason: string }> = [];
    const startedAt = Date.now();

    for (let index = 0; index < testCases.length; index += 1) {
      const testCase = testCases[index]!;
      const outcome = await this.executor.runSkill(skill, testCase.input);

      if (!outcome.success) {
        failed += 1;
        failures.push({ index, reason: outcome.error ?? "execution failed" });
        continue;
      }

      const matches = deepEquals(outcome.output, testCase.expectedOutput);
      if (matches) {
        passed += 1;
      } else {
        failed += 1;
        failures.push({
          index,
          reason: `output mismatch: expected ${safeStringify(testCase.expectedOutput)}, got ${safeStringify(outcome.output)}`,
        });
      }
    }

    const successRate = testCases.length > 0 ? passed / testCases.length : 0;
    const durationMs = Date.now() - startedAt;

    // A skill only counts as a successful execution when every case passed.
    const allPassed = testCases.length > 0 && failed === 0;
    this.skillLibrary.recordExecution(skillId, allPassed, durationMs);

    // Verification status must reflect measured behaviour, never a guess.
    if (allPassed) {
      this.skillLibrary.updateSkill(skillId, { status: "verified" });
    } else if (testCases.length > 0) {
      this.skillLibrary.updateSkill(skillId, { status: "draft" });
    }

    return { passed, failed, successRate, failures };
  }

  /**
   * Trajectory'lerden skill sentezle.
   */
  synthesizeFromTrajectories(): SkillDefinition[] {
    const candidates = this.trajectoryMiner.mineCandidates();
    const skills: SkillDefinition[] = [];

    for (const candidate of candidates) {
      const skill = this.synthesizeFromCandidate(candidate);
      if (skill) {
        skills.push(skill);
      }
    }

    return skills;
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalSkills: number;
    draftSkills: number;
    verifiedSkills: number;
    totalCandidates: number;
  } {
    const skills = this.skillLibrary.getSkills();
    return {
      totalSkills: skills.length,
      draftSkills: skills.filter(s => s.status === "draft").length,
      verifiedSkills: skills.filter(s => s.status === "verified").length,
      totalCandidates: this.trajectoryMiner.getCandidates().length,
    };
  }
}

/**
 * Skill Synthesis Pipeline
 * 
 * Trajectory mining → skill candidates → parameterize → verify → eval.
 */
export class SkillSynthesisPipeline {
  readonly skillLibrary: SkillLibraryManager;
  readonly trajectoryMiner: TrajectoryMiner;
  readonly skillSynthesizer: SkillSynthesizer;

  constructor() {
    this.skillLibrary = new SkillLibraryManager();
    this.trajectoryMiner = new TrajectoryMiner();
    this.skillSynthesizer = new SkillSynthesizer(this.skillLibrary, this.trajectoryMiner);
  }

  /**
   * Pipeline'ı çalıştır.
   */
  async runPipeline(): Promise<{
    candidates: SkillSynthesisCandidate[];
    synthesized: SkillDefinition[];
    verified: SkillDefinition[];
  }> {
    // 1. Trajectory'lerden candidate'ları çıkar
    const candidates = this.trajectoryMiner.mineCandidates();

    // 2. Candidate'lardan skill oluştur
    const synthesized: SkillDefinition[] = [];
    for (const candidate of candidates) {
      const skill = this.skillSynthesizer.synthesizeFromCandidate(candidate);
      if (skill) {
        synthesized.push(skill);
      }
    }

    // 3. Skill'leri verify et
    const verified: SkillDefinition[] = [];
    for (const skill of synthesized) {
      if (this.skillSynthesizer.verifySkill(skill.id)) {
        verified.push(skill);
      }
    }

    return { candidates, synthesized, verified };
  }

  /**
   * Pipeline istatistiklerini al.
   */
  getStats(): {
    skillLibrary: ReturnType<SkillLibraryManager["getStats"]>;
    trajectoryMiner: ReturnType<TrajectoryMiner["getStats"]>;
    skillSynthesizer: ReturnType<SkillSynthesizer["getStats"]>;
  } {
    return {
      skillLibrary: this.skillLibrary.getStats(),
      trajectoryMiner: this.trajectoryMiner.getStats(),
      skillSynthesizer: this.skillSynthesizer.getStats(),
    };
  }
}
