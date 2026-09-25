/**
 * Extension execution must not report success it did not earn.
 *
 * `executeInSandbox()` used to return `{ success: true, extension, input }`
 * without running anything. The lie compounded through the stack:
 *
 *     fake sandbox → execution.status = "success" → stats().successRate = 1.0
 *
 * So an extension that had never once executed advertised a 100% success rate.
 * There were no tests over this service at all, which is why it survived.
 *
 * These tests pin the honest behaviour: no sandbox means a named error and a
 * recorded failure, and the success rate reflects that.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentSDKService,
  ExtensionSandboxUnavailableError,
  type Extension,
} from "../src/sdk/agent-sdk-service.js";

let dir: string;
let sdk: AgentSDKService;

const TENANT = "tenant-a";

function extensionInput(): Omit<Extension, "id" | "status" | "createdAt" | "updatedAt"> {
  return {
    tenantId: TENANT,
    name: "csv-summariser",
    description: "Summarises a CSV file",
    type: "tool",
    version: "1.0.0",
    author: "tester",
    manifest: {
      entrypoint: "index.js",
      runtime: "javascript",
      dependencies: [],
      config: [],
      hooks: [],
      capabilities: [],
      minEngineVersion: "1.0.0",
    },
    permissions: {
      filesystem: { read: [], write: [] },
      network: { allowed: [], blocked: [] },
      database: { read: [], write: [] },
      capabilities: [],
      maxExecutionMs: 1000,
      maxMemoryMb: 64,
    },
  } as Omit<Extension, "id" | "status" | "createdAt" | "updatedAt">;
}

async function activeInstance(): Promise<string> {
  const extension = await sdk.registerExtension(TENANT, extensionInput());
  // Extensions start as `draft` and only published ones may run — a separate,
  // correct guard that this test satisfies rather than bypasses.
  await sdk.updateExtensionStatus(extension.id, "published");
  const instance = await sdk.createInstance(extension.id, TENANT, {});
  return instance.id;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "haf-sdk-"));
  sdk = new AgentSDKService(dir);
  await sdk.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("an extension that cannot run is not a success", () => {
  it("records an error rather than echoing the input back as output", async () => {
    const execution = await sdk.execute(await activeInstance(), TENANT, { file: "data.csv" });

    expect(execution.status).toBe("error");
    expect(execution.output).toBeUndefined();
  });

  it("names the missing capability instead of failing opaquely", async () => {
    const execution = await sdk.execute(await activeInstance(), TENANT, {});

    expect(execution.error).toContain("not implemented");
    expect(execution.error).toMatch(/isolate|sandbox/i);
  });

  it("exposes a typed error so callers can tell this apart from a real failure", () => {
    const error = new ExtensionSandboxUnavailableError("csv-summariser");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ExtensionSandboxUnavailableError");
    expect(error.extension).toBe("csv-summariser");
  });
});

describe("the success rate tells the truth", () => {
  it("reports 0% when nothing has ever executed successfully", async () => {
    const instanceId = await activeInstance();
    await sdk.execute(instanceId, TENANT, {});
    await sdk.execute(instanceId, TENANT, {});

    const stats = await sdk.getStats(TENANT);

    // Previously: 1.0, from two executions that never ran.
    expect(stats.successRate).toBe(0);
    expect(stats.totalExecutions).toBe(2);
  });

  it("still counts the attempt, so the failure is visible rather than hidden", async () => {
    const instanceId = await activeInstance();
    await sdk.execute(instanceId, TENANT, {});

    const stats = await sdk.getStats(TENANT);
    // The attempt is recorded (not swallowed) and it did not raise the rate.
    expect(stats.totalExecutions).toBe(1);
    expect(stats.successRate).toBe(0);
    // `byStatus` counts extension lifecycle states, not execution outcomes.
    expect(stats.byStatus["published"]).toBe(1);
  });
});

describe("execution status is not optimistic before the work happens", () => {
  it("never leaves a record claiming success when the sandbox threw", async () => {
    const instanceId = await activeInstance();
    const execution = await sdk.execute(instanceId, TENANT, {});

    // The record is created before the run; it must not start life as
    // "success" and rely on an exception path to correct it.
    expect(execution.status).not.toBe("success");
    expect(execution.completedAt).toBeTruthy();
    expect(execution.durationMs).toBeGreaterThanOrEqual(0);
  });
});
