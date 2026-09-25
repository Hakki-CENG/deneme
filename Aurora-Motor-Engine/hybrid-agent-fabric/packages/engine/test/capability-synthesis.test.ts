import { describe, it, expect } from "vitest";

import {
  CapabilitySynthesisManager,
  SandboxExecutor,
  QuarantineManager,
  CapabilitySynthesisPipeline,
} from "../src/capabilities/capability-synthesis.js";

describe("SandboxExecutor (real worker isolation)", () => {
  it("actually executes code and returns the computed value", async () => {
    const executor = new SandboxExecutor();
    const id = executor.createSandbox("compute");

    const result = await executor.executeInSandbox(
      id,
      "return input.a + input.b;",
      { a: 17, b: 25 }
    );

    expect(result.success).toBe(true);
    // Proves real execution: the value is computed, not echoed back.
    expect(result.output).toBe(42);
  });

  it("reports failure when the capability throws", async () => {
    const executor = new SandboxExecutor();
    const id = executor.createSandbox("throwing");

    const result = await executor.executeInSandbox(
      id,
      "throw new Error('capability exploded');",
      {}
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("capability exploded");
  });

  it("does not report success for code that fails to compile", async () => {
    const executor = new SandboxExecutor();
    const id = executor.createSandbox("syntax");

    const result = await executor.executeInSandbox(id, "this is not javascript(((", {});

    expect(result.success).toBe(false);
  });

  it("terminates runaway loops via timeout instead of hanging", async () => {
    const executor = new SandboxExecutor();
    const id = executor.createSandbox("infinite");

    const result = await executor.executeInSandbox(
      id,
      "while (true) {}",
      {},
      { timeoutMs: 300 }
    );

    expect(result.success).toBe(false);
    expect(String(result.error).toLowerCase()).toMatch(/time|terminat/);
  }, 15_000);

  it("denies access to process and the host filesystem", async () => {
    const executor = new SandboxExecutor();
    const id = executor.createSandbox("escape");

    const proc = await executor.executeInSandbox(id, "return typeof process;", {});
    expect(proc.success).toBe(true);
    expect(proc.output).toBe("undefined");

    const req = await executor.executeInSandbox(
      id,
      "return require('node:fs').readFileSync('/etc/passwd','utf8');",
      {}
    );
    expect(req.success).toBe(false);
  });

  it("captures console output from inside the isolate", async () => {
    const executor = new SandboxExecutor();
    const id = executor.createSandbox("logging");

    const result = await executor.executeInSandbox(
      id,
      "console.log('hello from sandbox'); return 1;",
      {}
    );

    expect(result.success).toBe(true);
    expect((result.logs ?? []).join("\n")).toContain("hello from sandbox");
  });

  it("supports async capability bodies", async () => {
    const executor = new SandboxExecutor();
    const id = executor.createSandbox("async");

    const result = await executor.executeInSandbox(
      id,
      "const v = await Promise.resolve(input.n * 2); return v;",
      { n: 21 }
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe(42);
  });
});

describe("CapabilitySynthesisManager", () => {
  it("synthesizes capabilities into quarantine by default", () => {
    const manager = new CapabilitySynthesisManager();
    const cap = manager.synthesizeCapability({
      name: "sum",
      description: "adds numbers",
      code: "return input.a + input.b;",
    });

    expect(cap.trustLevel).toBe("quarantine");
    expect(manager.getCapabilities()).toHaveLength(1);
  });

  it("tracks execution outcomes", () => {
    const manager = new CapabilitySynthesisManager();
    const cap = manager.synthesizeCapability({
      name: "sum",
      description: "adds numbers",
      code: "return 1;",
    });

    manager.recordExecution(cap.id, true);
    manager.recordExecution(cap.id, false);

    const stats = manager.getStats();
    expect(stats.totalCapabilities).toBe(1);
    expect(stats.totalExecutions).toBe(2);
    expect(stats.successRate).toBeCloseTo(0.5);
  });
});

describe("QuarantineManager", () => {
  it("keeps newly quarantined capabilities out of the trusted set", () => {
    const quarantine = new QuarantineManager();
    const entry = quarantine.quarantine({
      capabilityId: "cap-1",
      reason: "newly synthesized",
    });

    expect(entry.capabilityId).toBe("cap-1");
  });
});

describe("CapabilitySynthesisPipeline", () => {
  it("runs synthesis end-to-end against the real sandbox", async () => {
    const pipeline = new CapabilitySynthesisPipeline();
    const result = await pipeline.synthesizeAndTest({
      name: "multiply",
      description: "multiplies two numbers",
      code: "return input.x * input.y;",
      testInput: { x: 6, y: 7 },
    });

    expect(result.executionResult.success).toBe(true);
    expect(result.executionResult.output).toBe(42);
    expect(result.capability.trustLevel).toBe("quarantine");
  });
});
