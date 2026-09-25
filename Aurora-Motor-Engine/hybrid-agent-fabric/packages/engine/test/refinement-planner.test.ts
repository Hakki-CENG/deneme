import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import type { ModelProvider } from "../src/types.js";

const engines: HybridAgentEngine[] = [];
afterEach(async () => await Promise.all(engines.splice(0).map((engine) => engine.shutdown())));

function provider(): ModelProvider {
  return {
    id: "refiner-test",
    async *stream(request) {
      const output = request.turnId.startsWith("refinement-")
        ? JSON.stringify({
            shouldRefine: true,
            rationale: "The user required repeatable verification evidence.",
            edits: [{
              kind: "prompt_addendum",
              title: "verification evidence",
              content: "Run focused checks and cite their result before completion.",
              expectedOutcome: "Completion claims include concrete verification.",
              risk: "low",
            }],
          })
        : "normal response";
      yield { type: "text_delta", delta: output };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

async function engine(autoRefineEveryTurns = 0) {
  const value = new HybridAgentEngine({
    homePath: await mkdtemp(join(tmpdir(), "haf-refinement-planner-")),
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    autoRefineEveryTurns,
    model: { provider: "mock" },
  });
  value.models.register(provider());
  await value.initialize();
  engines.push(value);
  const session = await value.createSession({ tenantId: "tenant" });
  await value.command({
    protocolVersion: 1, commandId: crypto.randomUUID(), clientId: "test", tenantId: "tenant",
    sessionId: session.sessionId, kind: "model.select", source: "api", issuedAt: new Date().toISOString(), payload: { model: "refiner-test:model" },
  });
  return { value, session };
}

async function prompt(value: HybridAgentEngine, sessionId: string) {
  return await value.command({
    protocolVersion: 1, commandId: crypto.randomUUID(), clientId: "test", tenantId: "tenant",
    sessionId, kind: "session.prompt", source: "api", issuedAt: new Date().toISOString(), payload: { text: "Always verify the release with focused tests." },
  });
}

describe("model-planned continual-harness reviews", () => {
  it("creates evidence-backed governed candidates without self-promotion", async () => {
    const { value, session } = await engine();
    await prompt(value, session.sessionId);
    const result = await value.refinementPlanner.plan(session.sessionId, "manual", "Find a reusable verification policy.");
    expect(result.review.shouldRefine).toBe(true);
    expect(result.batch?.status).toBe("proposed");
    const candidates = await value.learning.list("tenant");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(expect.objectContaining({ status: "scanned", createdBy: "system", kind: "prompt_addendum" }));
    expect(await value.learning.activeArtifacts("tenant", session.sessionId)).toHaveLength(0);
  });

  it("runs an optional turn-interval review in single flight", async () => {
    const { value, session } = await engine(1);
    expect((await prompt(value, session.sessionId)).status).toBe("completed");
    for (let index = 0; index < 100; index++) {
      if ((await value.refinementPlanner.list("tenant", session.sessionId)).length) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    const reviews = await value.refinementPlanner.list("tenant", session.sessionId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(expect.objectContaining({ trigger: "turn_interval", shouldRefine: true }));
    expect((await value.refinements.list("tenant", session.sessionId))[0]?.status).toBe("proposed");
  });
});
