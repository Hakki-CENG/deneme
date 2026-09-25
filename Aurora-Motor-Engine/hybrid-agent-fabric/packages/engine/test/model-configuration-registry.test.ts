import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfigurationRegistry } from "../src/models/model-configuration-registry.js";
import { ProviderProfileRegistry } from "../src/models/provider-profiles.js";

const previous = process.env.TEST_MODEL_KEY;
afterEach(() => {
  if (previous === undefined) delete process.env.TEST_MODEL_KEY;
  else process.env.TEST_MODEL_KEY = previous;
});

describe("persistent server-side model configurations", () => {
  it("requires an exact credential audience for custom endpoints and never persists values", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-model-config-"));
    const profiles = new ProviderProfileRegistry();
    const registry = new ModelConfigurationRegistry(root, profiles);
    process.env.TEST_MODEL_KEY = "super-secret-model-key";
    await expect(registry.add({
      name: "unsafe", baseProfileId: "openai", model: "custom", baseUrl: "https://models.example.test/v1",
      credentialEnvironmentVariable: "TEST_MODEL_KEY",
    })).rejects.toThrow("credentialAudienceOrigin");
    const record = await registry.add({
      name: "safe custom", baseProfileId: "openai", model: "custom-model",
      baseUrl: "https://models.example.test/v1", dataPolicy: "provider", credentialEnvironmentVariable: "TEST_MODEL_KEY",
      credentialAudienceOrigin: "https://models.example.test",
      headerEnvironmentVariables: { "x-organization": "TEST_MODEL_KEY" },
    });
    expect(record.configured).toBe(true);
    expect(JSON.stringify(await registry.list())).not.toContain("super-secret-model-key");
    const materialized = await registry.materialize(record.id);
    expect(materialized.provider.id).toBe(record.id);
    expect(materialized.modelName).toBe(`${record.id}:custom-model`);
    const reloaded = new ModelConfigurationRegistry(root, profiles);
    expect((await reloaded.get(record.id)).credentialEnvironmentVariable).toBe("TEST_MODEL_KEY");
    expect(JSON.stringify(await reloaded.list())).not.toContain("super-secret-model-key");
  });

  it("binds OAuth routes to the same tenant and exact resource origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-oauth-model-config-"));
    const oauth = {
      async get(id: string, tenantId: string) {
        if (id !== "oauth-source" || tenantId !== "tenant") throw new Error("missing");
        return { id, tenantId, enabled: true, authenticated: true, resourceOrigins: ["https://api.example.test"] };
      },
      async authorization() { return { accessToken: "access", expiresAt: Date.now() + 60_000, resourceOrigins: ["https://api.example.test"] }; },
      async forceRefresh() { return { accessToken: "refresh", expiresAt: Date.now() + 60_000, resourceOrigins: ["https://api.example.test"] }; },
    } as any;
    const registry = new ModelConfigurationRegistry(root, new ProviderProfileRegistry(), oauth);
    await expect(registry.add({ tenantId: "tenant", name: "wrong origin", baseProfileId: "openai-responses", model: "model", baseUrl: "https://evil.example/v1", credentialOAuthSourceId: "oauth-source" })).rejects.toThrow("not authorized");
    const record = await registry.add({ tenantId: "tenant", name: "oauth route", baseProfileId: "openai-responses", model: "model", dataPolicy: "provider", baseUrl: "https://api.example.test/v1", credentialOAuthSourceId: "oauth-source" });
    expect(record).toMatchObject({ tenantId: "tenant", configured: true, credentialOAuthSourceId: "oauth-source", credentialAudienceOrigin: "https://api.example.test" });
    expect((await registry.materialize(record.id)).provider.id).toBe(record.id);
    expect(await registry.list("other")).toEqual([]);
  });

  it("supports credential-free local model configurations", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-local-model-config-"));
    const registry = new ModelConfigurationRegistry(root, new ProviderProfileRegistry());
    await expect(registry.add({ name: "unlabelled custom", baseProfileId: "ollama", model: "qwen", baseUrl: "http://127.0.0.1:12434/v1" })).rejects.toThrow("explicit dataPolicy");
    const local = await registry.add({
      name: "local lab", baseProfileId: "ollama", model: "qwen-local", baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(local.configured).toBe(true);
    expect((await registry.materialize(local.id)).provider.id).toBe(local.id);
    await registry.setEnabled(local.id, false);
    await expect(registry.materialize(local.id)).rejects.toThrow("disabled");
    expect(await registry.remove(local.id)).toBe(true);
  });
});
