import { z } from "zod";
import type { SelfDebuggingService } from "../aurora/self-debugging.js";
import type { SelfModelService } from "../aurora/self-model-service.js";
import { defineCapability } from "./schema.js";

/**
 * P2.8 / P2.9 / P2.7: the self-model's decision surfaces. The engine wires
 * `availableCapabilities`/`availableModels` to real sources, so every answer
 * here is measured or honestly absent — nothing is invented.
 */
export function selfModelCapabilities(
  service: SelfModelService,
  debugging: SelfDebuggingService,
  deps: {
    availableCapabilities: () => string[];
    availableModels: () => string[];
  },
) {
  return [
    defineCapability(
      {
        id: "self.decision.inputs",
        version: "1.0.0",
        description:
          "The self-model's complete decision input: strengths, weaknesses, per-capability reliability, known limitations, uncertainty (measured failure share), current workload and the tools/models actually available right now.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => await service.decisionInputs(context.tenantId, deps),
    ),
    defineCapability(
      {
        id: "self.advise",
        version: "1.0.0",
        description:
          "Ask the self-model how to approach a task: whether to verify the output, delegate, or ask the user, with the capability history that justifies each recommendation. No history means no recommendation — stated plainly.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ task: z.string().min(1).max(10_000) }),
      async ({ task }, context) => await service.advise(context.tenantId, task),
    ),
    defineCapability(
      {
        id: "self.limitations",
        version: "1.0.0",
        description: "Known limitations derived from measured failures and weak capability areas — never asserted, always evidenced.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => ({ limitations: await service.knownLimitations(context.tenantId) }),
    ),
    defineCapability(
      {
        id: "self.strategy.record",
        version: "1.0.0",
        description: "Record a strategy outcome (meta-learning input, P2.9): which strategy was used, whether it succeeded, and in what context.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        strategy: z.enum(["direct", "exploratory", "decompose", "delegate", "simulate", "fallback"]),
        success: z.boolean(),
        context: z.string().max(200).optional(),
      }),
      async ({ strategy, success, context }, ctx) => await service.recordStrategyOutcome(ctx.tenantId, strategy, success, ...(context ? [context] : [])),
    ),
    defineCapability(
      {
        id: "self.strategy.advice",
        version: "1.0.0",
        description:
          "Meta-learning advice (P2.9): when to verify, delegate, research or ask the user, derived from measured strategy outcomes and capability gaps. Returns insufficient-evidence rather than guessing below five samples.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => await service.strategyAdvice(context.tenantId),
    ),
    defineCapability(
      {
        id: "self.reflect",
        version: "1.0.0",
        description: "Run a reflection cycle now: failure patterns, weak areas, untested hypotheses and goal focus, with the trigger recorded (P2.14).",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ trigger: z.enum(["task", "failure", "milestone", "periodic"]).default("periodic") }),
      async ({ trigger }, context) => await service.reflect(context.tenantId, trigger),
    ),
    defineCapability(
      {
        id: "self.debug.selfheal",
        version: "1.0.0",
        description:
          "Self-debugging (P2.7): diagnose an unhealthy subsystem. Verified fixes from this tenant's own history are returned first; the symptom template only applies when no verified history exists, and says which basis was used.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        subsystem: z.string().min(1).max(200),
        symptoms: z.array(z.string().min(1).max(500)).min(1).max(20),
      }),
      async ({ subsystem, symptoms }, context) => await debugging.selfHeal(context.tenantId, subsystem, symptoms),
    ),
    defineCapability(
      {
        id: "self.debug.report",
        version: "1.0.0",
        description: "Report a bug for self-debugging: type, symptoms, affected subsystem, reproduction steps and severity.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        type: z.enum(["logic", "state", "timing", "resource", "data", "integration", "config", "unknown"]),
        description: z.string().min(1).max(2000),
        symptoms: z.array(z.string().min(1).max(500)).max(20),
        affectedSubsystem: z.string().min(1).max(200),
        reproductionSteps: z.array(z.string().min(1).max(1000)).max(20),
        severity: z.enum(["low", "medium", "high", "critical"]),
      }),
      async (input, context) => await debugging.reportBug(context.tenantId, input.type, input.description, input.symptoms, input.affectedSubsystem, input.reproductionSteps, input.severity),
    ),
  ];
}
