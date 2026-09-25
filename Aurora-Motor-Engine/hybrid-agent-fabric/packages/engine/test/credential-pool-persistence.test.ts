import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "../src/types.js";
import { ModelProviderError } from "../src/models/model-provider-error.js";
import { CredentialPoolModelProvider, FileCredentialPoolStateStore } from "../src/models/provider-credential-pool.js";

const request = { sessionId: "s", turnId: "t", systemPrompt: "system", messages: [], tools: [] } as unknown as ModelRequest;
async function run(provider: ModelProvider) { const events = []; for await (const event of provider.stream(request)) events.push(event); return events; }

describe("restart-persistent same-provider credential pools", () => {
  it("restores cooldown state without persisting key material", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-pool-state-"));
    const store = new FileCredentialPoolStateStore(root);
    let now = Date.parse("2026-08-19T00:00:00Z");
    const attempted: string[] = [];
    const factory = (apiKey: string): ModelProvider => ({ id: "pooled", async *stream() {
      attempted.push(apiKey);
      if (apiKey === "first-super-secret") throw new ModelProviderError("rate limited", { providerId: "pooled", status: 429, code: "rate_limited", retryable: true, credentialDisposition: "cooldown", retryAfterMs: 60_000 });
      yield { type: "text_delta", delta: "ok" }; yield { type: "done", stopReason: "end_turn" };
    } });
    const first = new CredentialPoolModelProvider("pooled", [
      { id: "first", apiKey: "first-super-secret" }, { id: "second", apiKey: "second-super-secret" },
    ], factory, { now: () => now, stateStore: store });
    await run(first);
    expect(first.status().entries.find((item) => item.id === "first")?.state).toBe("cooldown");
    const statePath = join(root, "models", "credential-pools", `${createHash("sha256").update("pooled").digest("hex")}.json`);
    const disk = await readFile(statePath, "utf8");
    expect(disk).not.toContain("first-super-secret"); expect(disk).not.toContain("second-super-secret");

    attempted.length = 0;
    const restarted = new CredentialPoolModelProvider("pooled", [
      { id: "first", apiKey: "first-super-secret" }, { id: "second", apiKey: "second-super-secret" },
    ], factory, { now: () => now, stateStore: store });
    expect(restarted.status().entries.find((item) => item.id === "first")?.state).toBe("cooldown");
    await run(restarted);
    expect(attempted).toEqual(["second-super-secret"]);
    now += 61_000;
    expect(restarted.status().entries.find((item) => item.id === "first")?.state).toBe("available");
  });

  it("persists credential disablement and requires an explicit reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-pool-disable-"));
    const store = new FileCredentialPoolStateStore(root);
    const attempted: string[] = [];
    const credentials = [{ id: "revoked", apiKey: "revoked-key" }, { id: "healthy", apiKey: "healthy-key" }];
    const factory = (apiKey: string): ModelProvider => ({ id: "provider", async *stream() {
      attempted.push(apiKey);
      if (apiKey === "revoked-key") throw new ModelProviderError("rejected", { providerId: "provider", status: 401, code: "credential_rejected", credentialDisposition: "disable" });
      yield { type: "done", stopReason: "end_turn" };
    } });
    const pool = new CredentialPoolModelProvider("provider", credentials, factory, { stateStore: store });
    await run(pool);
    expect(pool.status().entries.find((item) => item.id === "revoked")?.state).toBe("disabled");
    attempted.length = 0;
    const restarted = new CredentialPoolModelProvider("provider", credentials, factory, { stateStore: store });
    await run(restarted); expect(attempted).toEqual(["healthy-key"]);
    await restarted.reset("revoked");
    expect(restarted.status().entries.find((item) => item.id === "revoked")?.state).toBe("available");
    attempted.length = 0; await run(restarted); expect(attempted[0]).toBe("revoked-key");
  });

  it("ignores persisted entries that are no longer in the configured pool", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-pool-removed-"));
    const store = new FileCredentialPoolStateStore(root);
    await store.save("provider", [{ id: "removed", disabled: true, cooldownUntil: 0, failureCount: 9, lastFailureCode: "credential_rejected" }]);
    const pool = new CredentialPoolModelProvider("provider", [{ id: "current", apiKey: "current-key" }], () => ({ id: "provider", async *stream() { yield { type: "done", stopReason: "end_turn" }; } }), { stateStore: store });
    expect(pool.status().entries).toEqual([expect.objectContaining({ id: "current", state: "available", failureCount: 0 })]);
  });
});
