import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";

const engines: HybridAgentEngine[] = [];
afterEach(async () => await Promise.all(engines.splice(0).map((engine) => engine.shutdown())));

describe("tenant-scoped inbound channel profile routing", () => {
  it("matches priority rules, hashes identifiers and applies per-user profile snapshots", async () => {
    const engine = new HybridAgentEngine({
      homePath: await mkdtemp(join(tmpdir(), "haf-channel-routing-")),
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    engines.push(engine);
    const profile = await engine.agentProfiles.add({ tenantId: "tenant", name: "support", instructions: "Answer as support.", modelRoute: "mock:support" });
    const rule = await engine.channels.addRoutingRule({
      tenantId: "tenant", name: "telegram support", priority: 100,
      platforms: ["telegram"], chatTypes: ["group"], chatIds: ["group-raw-id"],
      sessionScope: "user", agentProfileId: profile.id,
    });
    expect(JSON.stringify(rule)).not.toContain("group-raw-id");
    expect(rule.chatIdHashes[0]).toMatch(/^[a-f0-9]{24}$/);
    const base = {
      tenantId: "tenant", platform: "telegram", chatId: "group-raw-id", chatType: "group" as const,
      text: "hello", authorized: true,
    };
    const first = await engine.channels.ingest({ ...base, userId: "user-1", messageId: "m1" });
    const same = await engine.channels.ingest({ ...base, userId: "user-1", messageId: "m2" });
    const second = await engine.channels.ingest({ ...base, userId: "user-2", messageId: "m3" });
    expect(same.sessionId).toBe(first.sessionId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect((await engine.session(first.sessionId)).agentProfile).toEqual(expect.objectContaining({ id: profile.id, modelRoute: "mock:support" }));
    const routes = await engine.channels.listRoutes("tenant");
    expect(routes.every((route) => route.routingRuleId === rule.id && route.agentProfileId === profile.id)).toBe(true);
    expect(JSON.stringify(routes)).not.toContain("group-raw-id");
  });

  it("isolates rule tenants and falls back to the default lane when disabled", async () => {
    const engine = new HybridAgentEngine({
      homePath: await mkdtemp(join(tmpdir(), "haf-channel-routing-default-")),
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    engines.push(engine);
    const rule = await engine.channels.addRoutingRule({ tenantId: "tenant", name: "disabled", platforms: ["slack"], sessionScope: "chat" });
    await engine.channels.setRoutingRuleEnabled(rule.id, "tenant", false);
    const delivery = await engine.channels.ingest({
      tenantId: "tenant", platform: "slack", chatId: "channel", chatType: "channel",
      userId: "user", text: "default", messageId: "event", authorized: true,
    });
    expect((await engine.session(delivery.sessionId)).agentProfile).toBeUndefined();
    await expect(engine.channels.setRoutingRuleEnabled(rule.id, "other", true)).rejects.toThrow("not found in tenant");
    expect(await engine.channels.listRoutingRules("other")).toEqual([]);
  });
});
