import type { AutonomousState, GoalState } from "../types.js";

export interface GateExecutionResult {
  command: string;
  exitCode: number | null;
  output: string;
}

export interface ContinuationDecision {
  continue: boolean;
  reason:
    | "disabled"
    | "goal_active"
    | "autonomous_no_gate"
    | "gate_failed"
    | "gates_passed"
    | "limit_reached"
    | "goal_completed";
  prompt?: string;
  limit?: string;
}

export interface ContinuationEvaluationInput {
  autonomous?: AutonomousState;
  goal?: GoalState;
  now?: Date;
  runGate: (command: string, timeoutMs: number) => Promise<GateExecutionResult>;
  workspaceFingerprint: () => Promise<string>;
}

function autonomousLimit(state: AutonomousState, now: Date): string | undefined {
  if (state.continuationsUsed >= state.maxContinuations) return "max_continuations";
  if (state.turnsUsed >= state.maxTurns) return "max_turns";
  if (state.tokensUsed >= state.maxTokens) return "max_tokens";
  if (state.startedAt && now.getTime() - new Date(state.startedAt).getTime() >= state.timeoutMs) return "timeout";
  return undefined;
}

function goalLimit(goal: GoalState): string | undefined {
  if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) return "goal_token_budget";
  if (goal.continuationCount >= goal.maxContinuations) return "goal_max_continuations";
  return undefined;
}

export async function evaluateContinuation(input: ContinuationEvaluationInput): Promise<ContinuationDecision> {
  const now = input.now ?? new Date();
  const goal = input.goal;
  const autonomous = input.autonomous;

  if (goal?.status === "completed") return { continue: false, reason: "goal_completed" };
  const goalLimitReason = goal?.status === "active" ? goalLimit(goal) : undefined;
  if (goalLimitReason) return { continue: false, reason: "limit_reached", limit: goalLimitReason };

  if (!autonomous?.enabled) {
    if (goal?.status === "active") {
      return {
        continue: true,
        reason: "goal_active",
        prompt: `Continue working on the persistent goal: ${goal.objective}. Mark it complete only with goal.complete and include verifiable evidence.`,
      };
    }
    return { continue: false, reason: "disabled" };
  }

  const limit = autonomousLimit(autonomous, now);
  if (limit) return { continue: false, reason: "limit_reached", limit };

  if (autonomous.gates.length === 0) {
    return { continue: true, reason: "autonomous_no_gate", prompt: autonomous.continuationPrompt };
  }

  const fingerprint = await input.workspaceFingerprint();
  for (const command of autonomous.gates) {
    const attempts = autonomous.gateAttempts[command] ?? 0;
    if (attempts >= autonomous.gateMaxRetries) {
      return { continue: false, reason: "limit_reached", limit: `gate_retries:${command}` };
    }
    if (autonomous.lastGateFailure?.command === command && autonomous.lastGateFingerprint === fingerprint) {
      autonomous.gateAttempts[command] = attempts + 1;
      if (autonomous.gateAttempts[command]! >= autonomous.gateMaxRetries) {
        return { continue: false, reason: "limit_reached", limit: `unchanged_workspace:${command}` };
      }
      return {
        continue: true,
        reason: "gate_failed",
        prompt: `The quality gate ${JSON.stringify(command)} was not rerun because the workspace is unchanged since its failure. Change the implementation before retrying. Previous output:\n${autonomous.lastGateFailure.output}`,
      };
    }
    const result = await input.runGate(command, autonomous.gateTimeoutMs);
    if (result.exitCode !== 0) {
      autonomous.gateAttempts[command] = attempts + 1;
      autonomous.lastGateFailure = result;
      autonomous.lastGateFingerprint = fingerprint;
      return {
        continue: true,
        reason: "gate_failed",
        prompt: `Quality gate ${JSON.stringify(command)} failed with exit code ${result.exitCode}. Fix the failure and verify again. Bounded output:\n${result.output}`,
      };
    }
    autonomous.gateAttempts[command] = 0;
  }
  delete autonomous.lastGateFailure;
  delete autonomous.lastGateFingerprint;
  return { continue: false, reason: "gates_passed" };
}
