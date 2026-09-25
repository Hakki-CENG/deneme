/**
 * B1 (P1.1): the API surface forwards task identity to the execution primitive
 * and stamps its own provenance.
 *
 * This registers the REAL route (`registerCognitiveRoutes`) against a stub
 * engine, so what is asserted is the route's actual behaviour — parsing,
 * passthrough, provenance stamping and the echoed receipt — not a re-implementation
 * of it. The stub records what `engine.execute` was called with.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { registerCognitiveRoutes } from "../src/routes/cognitive.js";

interface CapturedExecute {
  tenantId: string;
  goal: string;
  userId?: string | undefined;
  parentTaskId?: string | undefined;
  priority?: string | undefined;
  deadline?: string | undefined;
  provenance?: { surface: string; ref?: string | undefined } | undefined;
}

function stubEngine(captured: CapturedExecute[]): { execute: (input: CapturedExecute) => Promise<Record<string, unknown>> } {
  return {
    execute: async (input) => {
      captured.push(input);
      // A minimal but honest report: identity echoed, status unverified
      // (nothing verified it).
      return {
        taskId: "task-1",
        tenantId: input.tenantId,
        status: "unverified",
        goal: input.goal,
        verification: undefined,
        attempts: 1,
        failures: [],
        gaps: [],
        outcomes: [],
        plan: undefined,
        spend: { tokens: 0, toolCalls: 0, costUsd: 0, recoveryAttempts: 0, wallMs: 0 },
        durationMs: 1,
        trace: [],
        summary: "stub",
        invokedCapabilities: [],
        observations: [],
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
        ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
      };
    },
  };
}

async function appWith(captured: CapturedExecute[]): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });
  const auroraTenant = z.object({ tenantId: z.string().default("local") });
  registerCognitiveRoutes(
    app as never,
    stubEngine(captured) as never,
    z,
    auroraTenant as never,
  );
  await app.ready();
  return app;
}

describe("/v1/run-task task identity (P1.1 / B1)", () => {
  it("forwards identity to the execution primitive and echoes it back", async () => {
    const captured: CapturedExecute[] = [];
    const app = await appWith(captured);

    const res = await app.inject({
      method: "POST",
      url: "/v1/run-task",
      payload: {
        task: "Do the thing",
        userId: "user-9",
        parentTaskId: "task-8",
        priority: "P1",
        deadline: "2026-09-26T09:00:00.000Z",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(captured.length).toBe(1);
    expect(captured[0]!.userId).toBe("user-9");
    expect(captured[0]!.parentTaskId).toBe("task-8");
    expect(captured[0]!.priority).toBe("P1");
    expect(captured[0]!.deadline).toBe("2026-09-26T09:00:00.000Z");

    const body = res.json();
    // The response is the receipt: a caller that submitted a deadline should
    // not have to trust that it was recorded.
    expect(body.userId).toBe("user-9");
    expect(body.parentTaskId).toBe("task-8");
    expect(body.priority).toBe("P1");
    expect(body.deadline).toBe("2026-09-26T09:00:00.000Z");
    expect(body.tenantId).toBe("local");
  });

  it("stamps provenance as the api surface, with the request id as its reference", async () => {
    const captured: CapturedExecute[] = [];
    const app = await appWith(captured);

    const res = await app.inject({ method: "POST", url: "/v1/run-task", payload: { task: "x" } });

    expect(res.statusCode).toBe(200);
    expect(captured[0]!.provenance?.surface).toBe("api");
    // Fastify generates a request id; the surface's reference for the work.
    expect(typeof captured[0]!.provenance?.ref).toBe("string");
    expect(res.json().provenance).toEqual({ surface: "api", ref: captured[0]!.provenance?.ref });
  });

  it("does not default identity a request did not supply", async () => {
    const captured: CapturedExecute[] = [];
    const app = await appWith(captured);

    const res = await app.inject({ method: "POST", url: "/v1/run-task", payload: { task: "x" } });

    expect(res.statusCode).toBe(200);
    expect(captured[0]!.userId).toBeUndefined();
    expect(captured[0]!.parentTaskId).toBeUndefined();
    expect(captured[0]!.priority).toBeUndefined();
    expect(captured[0]!.deadline).toBeUndefined();
    // Absent on the way in, absent on the way back — not defaulted to "local"
    // or anything else.
    const body = res.json();
    expect(body.userId).toBeUndefined();
    expect(body.deadline).toBeUndefined();
  });
});
