import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { HybridAgentEngine } from "../src/engine.js";

/**
 * Model routing used to be disconnected from the system it was routing for.
 *
 * The task loop asked `ModelRoutingService`, whose model list is filled only by
 * `addDefaultModels()` -- three hardcoded entries. `ModelRouter`, which holds the
 * providers actually registered, was never consulted on that path, and
 * `ModelSelectionEngine` -- built to bridge the two -- was never called at all.
 *
 * These tests run the real engine so the wiring is what is under test, not a
 * reconstruction of it.
 */
async function makeEngine(): Promise<HybridAgentEngine> {
  const workspace = mkdtempSync(join(tmpdir(), "routing-ws-"));
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify(
      {
        name: "routing-fixture",
        version: "1.0.0",
        private: true,
        scripts: { build: "node -e \"require('fs').writeFileSync('built.txt','ok')\"" },
      },
      null,
      2,
    ),
  );
  const engine = new HybridAgentEngine({
    homePath: mkdtempSync(join(tmpdir(), "routing-home-")),
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    model: { provider: "mock" },
    autoApproveWorkspaceWrites: true,
    allowProcessExecution: true,
  });
  await engine.initialize();
  return engine;
}

/** A provider with no behaviour; only its registration matters here. */
function stubProvider(id: string) {
  return { id, stream: async function* () {} };
}

describe("model routing reads the registered providers", () => {
  it("only ever selects a route that can actually be run", async () => {
    const engine = await makeEngine();
    try {
      engine.models.register(stubProvider("anthropic"));

      const decision = await engine.modelSelectionEngine.select({
        tenantId: "local",
        taskDescription: "Refactor the code and fix the bug",
        strategy: "quality",
      });

      // Was a hardcoded list containing models that do not exist in the engine.
      // Now the decision is a provider:model route drawn from the registry.
      expect(decision.selectedModel).toMatch(/^anthropic:/);
      expect(engine.models.list()).toContain(decision.selectedModel.split(":")[0]);
    } finally {
      await engine.shutdown();
    }
  });

  it("returns no selection rather than inventing a model when nothing is runnable", async () => {
    // The default engine registers `mock`, which has no provider profile and
    // therefore no model to name. Naming one anyway would send the session to a
    // model that does not exist.
    const engine = await makeEngine();
    try {
      const decision = await engine.modelSelectionEngine.select({
        tenantId: "local",
        taskDescription: "Refactor the code",
        strategy: "quality",
      });

      expect(decision.selectedModel).toBe("");
      expect(decision.reason).toContain("No runnable model");
    } finally {
      await engine.shutdown();
    }
  });

  it("prefers a model the tenant actually configured", async () => {
    const engine = await makeEngine();
    try {
      engine.models.register(stubProvider("anthropic"));
      await engine.modelConfigurations.add({
        tenantId: "local",
        name: "Configured",
        baseProfileId: "anthropic",
        model: "tenant-choice",
        dataPolicy: "local",
        headerEnvironmentVariables: {},
      });

      const candidates = await engine.modelSelectionEngine.candidates("local");
      expect(candidates.map((candidate) => candidate.route)).toEqual(["anthropic:tenant-choice"]);
    } finally {
      await engine.shutdown();
    }
  });

  it("reports how many providers the decision was made from", async () => {
    const engine = await makeEngine();
    try {
      const decision = await engine.modelSelectionEngine.select({
        tenantId: "local",
        taskDescription: "Summarise the document",
        strategy: "balanced",
      });

      expect(decision.registeredProviders).toBe(engine.models.list().length);
      expect(decision.registeredProviders).toBeGreaterThan(0);
    } finally {
      await engine.shutdown();
    }
  });

  it("does not let registration order decide the winner", async () => {
    // latencyMs used to be 1000 + idx * 500 and cost 0.001 / (idx + 1), so the
    // first registered provider was the fastest and the cheapest by construction
    // and won every strategy. With nothing learned, every provider must score the
    // same -- an arbitrary choice has to look arbitrary.
    const engine = await makeEngine();
    try {
      // Two providers whose profiles both name a default model, so there are two
      // real candidates and neither is unmeasured-but-favoured by its position.
      engine.models.register(stubProvider("anthropic"));
      engine.models.register(stubProvider("openrouter"));

      const decision = await engine.modelSelectionEngine.select({
        tenantId: "local",
        taskDescription: "Refactor the code and fix the bug",
        strategy: "quality",
      });

      expect(decision.alternatives.length).toBe(1);
      expect(decision.measuredCandidates).toBe(0);
      for (const alternative of decision.alternatives) {
        expect(alternative.score).toBe(decision.selectedScore);
      }
    } finally {
      await engine.shutdown();
    }
  });

  it("keeps the selected score alongside the alternatives", async () => {
    const engine = await makeEngine();
    try {
      engine.models.register(stubProvider("openai"));

      const decision = await engine.modelSelectionEngine.select({
        tenantId: "local",
        taskDescription: "Translate the readme",
        strategy: "performance",
      });

      // `alternatives` excludes the winner, so without this field the strength of
      // the decision could not be measured from outside the router.
      expect(decision.selectedScore).toBeGreaterThanOrEqual(
        Math.max(0, ...decision.alternatives.map((a) => a.score)),
      );
    } finally {
      await engine.shutdown();
    }
  });
});

describe("the routing decision reaches the caller", () => {
  it("is carried on the report rather than only counted", async () => {
    // `observe()` wrote to a list the report never exposed; the only reader took
    // its length. The loop worked out a routing decision no caller could see.
    const engine = await makeEngine();
    try {
      const workspace = mkdtempSync(join(tmpdir(), "routing-report-ws-"));
      writeFileSync(
        join(workspace, "package.json"),
        JSON.stringify(
          {
            name: "routing-report-fixture",
            version: "1.0.0",
            private: true,
            scripts: { build: "node -e \"require('fs').writeFileSync('built.txt','ok')\"" },
          },
          null,
          2,
        ),
      );

      const report = await engine.execute({
        tenantId: "local",
        sessionId: "routing-1",
        familyId: "routing-1",
        goal: "Refactor the code and fix the bug in parser.ts",
        workspace,
      });

      const routing = report.observations.filter((entry) => entry.source === "routing");
      expect(routing.length).toBeGreaterThan(0);
      // The default engine has nothing runnable, and the observation says so
      // instead of naming a model that does not exist.
      expect(routing[0]?.summary).toContain("(no runnable model)");
      expect(routing[0]?.summary).toMatch(/confidence/);
    } finally {
      await engine.shutdown();
    }
  });

  it("classifies the task type from the goal", async () => {
    const engine = await makeEngine();
    try {
      const workspace = mkdtempSync(join(tmpdir(), "routing-type-ws-"));
      writeFileSync(
        join(workspace, "package.json"),
        JSON.stringify(
          {
            name: "routing-type-fixture",
            version: "1.0.0",
            private: true,
            scripts: { build: "node -e \"require('fs').writeFileSync('built.txt','ok')\"" },
          },
          null,
          2,
        ),
      );

      const report = await engine.execute({
        tenantId: "local",
        sessionId: "routing-2",
        familyId: "routing-2",
        goal: "Summarise the quarterly report",
        workspace,
      });

      const routing = report.observations.filter((entry) => entry.source === "routing");
      expect(routing[0]?.summary).toContain('"summarization"');
    } finally {
      await engine.shutdown();
    }
  });
});

describe("selection is driven by measurement, not by position", () => {
  it("prefers a model with recorded outcomes over one with none", async () => {
    const engine = await makeEngine();
    try {
      engine.models.register(stubProvider("anthropic"));
      for (const model of ["unmeasured-model", "measured-model"]) {
        await engine.modelConfigurations.add({
          tenantId: "local",
          name: model,
          baseProfileId: "anthropic",
          model,
          dataPolicy: "local",
          headerEnvironmentVariables: {},
        });
      }
      await engine.modelCapabilityRegistry.register({
        modelId: "measured-model",
        displayName: "Measured",
        provider: "anthropic",
        capabilities: ["code"],
        contextWindow: 8000,
      });
      for (let index = 0; index < 5; index += 1) {
        await engine.modelCapabilityRegistry.recordOutcome("measured-model", true, 120);
      }

      const decision = await engine.modelSelectionEngine.select({
        tenantId: "local",
        taskDescription: "Refactor the code",
        strategy: "quality",
      });

      expect(decision.selectedModel).toBe("anthropic:measured-model");
      expect(decision.measuredCandidates).toBe(1);
      expect(decision.selectedScore).toBeGreaterThan(
        decision.alternatives[0]?.score ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      await engine.shutdown();
    }
  });

  it("says when the winner has no evidence behind it", async () => {
    const engine = await makeEngine();
    try {
      engine.models.register(stubProvider("anthropic"));

      const decision = await engine.modelSelectionEngine.select({
        tenantId: "local",
        taskDescription: "Refactor the code",
        strategy: "quality",
      });

      expect(decision.measuredCandidates).toBe(0);
      expect(decision.reason).toContain("not evidence-based");
    } finally {
      await engine.shutdown();
    }
  });
});

describe("the applied route", () => {
  it("is applied to the task when a runnable model exists", async () => {
    const engine = await makeEngine();
    try {
      engine.models.register(stubProvider("anthropic"));
      await engine.modelConfigurations.add({
        tenantId: "local",
        name: "Configured",
        baseProfileId: "anthropic",
        model: "tenant-choice",
        dataPolicy: "local",
        headerEnvironmentVariables: {},
      });
      const workspace = mkdtempSync(join(tmpdir(), "routing-applied-ws-"));
      writeFileSync(
        join(workspace, "package.json"),
        JSON.stringify(
          {
            name: "routing-applied-fixture",
            version: "1.0.0",
            private: true,
            scripts: { build: "node -e \"require('fs').writeFileSync('built.txt','ok')\"" },
          },
          null,
          2,
        ),
      );

      const report = await engine.execute({
        tenantId: "local",
        sessionId: "applied-1",
        familyId: "applied-1",
        goal: "Refactor the code and fix the bug in parser.ts",
        workspace,
      });

      const routing = report.observations.filter((entry) => entry.source === "routing");
      // "applied" means the route was set on the context, not merely recorded.
      expect(routing[0]?.summary).toContain("anthropic:tenant-choice");
      expect(routing[0]?.summary).toContain("applied");
    } finally {
      await engine.shutdown();
    }
  });
});
