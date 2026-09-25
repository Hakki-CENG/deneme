import { z } from "zod";
import type { VerificationService } from "../harness/verification-service.js";
import { defineCapability } from "./schema.js";

/**
 * Verification as a capability.
 *
 * `verify.recipe` is a read: what would this project be checked with? `verify.run` executes those
 * checks and carries the same `process` risk class as any other command execution, because that is
 * exactly what it is. `verify.evidence` is how an agent answers "prove it" — and how a reviewer finds
 * out that it cannot.
 */
export function verificationCapabilities(verification: VerificationService) {
  const phase = z.enum(["bootstrap", "build", "test", "lint"]);
  return [
    defineCapability(
      {
        id: "verify.recipe",
        version: "1.0.0",
        description: "Detect how this project verifies itself: package manager, build, test and lint commands, and the files that revealed them.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => await verification.detect(context.workspacePath),
    ),
    defineCapability(
      {
        id: "verify.run",
        version: "1.0.0",
        description: "Run the project's own build and test commands and record the evidence. Stops at the first failing phase.",
        risk: "process",
        sideEffect: true,
        source: "core",
      },
      z.object({
        phases: z.array(phase).min(1).max(4).optional(),
        timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
      }),
      async (input, context) => await verification.run({
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        ...(input.phases ? { phases: input.phases } : {}),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    ),
    defineCapability(
      {
        id: "verify.evidence",
        version: "1.0.0",
        description: "The verification evidence this session can point at: the latest run, its verdict, and recent history.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ limit: z.number().int().min(1).max(50).optional() }),
      async (input, context) => ({
        latest: await verification.latest(context.tenantId, context.sessionId),
        history: await verification.list({
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      }),
    ),
  ];
}
