import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { signingPayload } from "../src/security/manifest-trust.js";

function publisherKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign: (payload: string) => signPayload(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
  };
}

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-trust-"));
  const engine = new HybridAgentEngine({
    homePath, kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local", model: { provider: "mock" },
  });
  return { engine };
}

const artifact = { kind: "skill" as const, artifactId: "hub:formatter", version: "1.2.0", sha256: "a".repeat(64) };

describe("Manifest trust", () => {
  it("verifies a signature from a registered publisher and rejects a forged one", async () => {
    const { engine } = await fixture();
    const keys = publisherKeys();
    await engine.manifestTrust.addPublisher({ id: "acme", name: "Acme Tools", publicKey: keys.publicKey });

    const good = await engine.manifestTrust.evaluate({ tenantId: "tenant", ...artifact, signature: keys.sign(signingPayload(artifact)), publisherId: "acme" });
    expect(good).toMatchObject({ allowed: true, signatureState: "valid", publisherId: "acme" });

    // A signature over a different version must not validate this one: that is the attack.
    const forged = await engine.manifestTrust.evaluate({
      tenantId: "tenant", ...artifact,
      signature: keys.sign(signingPayload({ ...artifact, version: "9.9.9" })),
      publisherId: "acme",
    });
    expect(forged).toMatchObject({ allowed: false, signatureState: "invalid" });

    const unknown = await engine.manifestTrust.evaluate({ tenantId: "tenant", ...artifact, signature: keys.sign(signingPayload(artifact)), publisherId: "nobody" });
    expect(unknown.signatureState).toBe("unknown-publisher");
    await engine.shutdown();
  });

  it("distinguishes absent, invalid and unknown-publisher instead of collapsing them", async () => {
    const { engine } = await fixture();
    const absent = await engine.manifestTrust.evaluate({ tenantId: "tenant", ...artifact });
    expect(absent).toMatchObject({ allowed: true, signatureState: "absent", pinState: "absent" });

    await engine.manifestTrust.configure({ tenantId: "tenant", requireSignature: true });
    const required = await engine.manifestTrust.evaluate({ tenantId: "tenant", ...artifact });
    expect(required.allowed).toBe(false);
    expect(required.reasons.join(" ")).toMatch(/requires one/);
    await engine.shutdown();
  });

  it("refuses an artefact that drifted from its pin even with a valid signature", async () => {
    const { engine } = await fixture();
    const keys = publisherKeys();
    await engine.manifestTrust.addPublisher({ id: "acme", name: "Acme", publicKey: keys.publicKey });
    await engine.manifestTrust.pin({ ...artifact, reason: "Reviewed 1.2.0" });

    const matched = await engine.manifestTrust.evaluate({ tenantId: "tenant", ...artifact, signature: keys.sign(signingPayload(artifact)), publisherId: "acme" });
    expect(matched.pinState).toBe("matched");

    const drifted = { ...artifact, version: "1.3.0" };
    const result = await engine.manifestTrust.evaluate({ tenantId: "tenant", ...drifted, signature: keys.sign(signingPayload(drifted)), publisherId: "acme" });
    expect(result).toMatchObject({ allowed: false, signatureState: "valid", pinState: "mismatched" });
    expect(await engine.manifestTrust.unpin("skill", artifact.artifactId)).toEqual({ artifactId: artifact.artifactId, removed: true });
    await engine.shutdown();
  });

  it("records every verdict and never leaks a public key through the listing", async () => {
    const { engine } = await fixture();
    const keys = publisherKeys();
    await engine.manifestTrust.addPublisher({ id: "acme", name: "Acme", publicKey: keys.publicKey });
    await engine.manifestTrust.evaluate({ tenantId: "tenant", ...artifact });
    const decisions = await engine.manifestTrust.decisions(10);
    expect(decisions[0]?.artifactId).toBe(artifact.artifactId);
    const listed = await engine.manifestTrust.publishers();
    expect(listed[0]).toMatchObject({ id: "acme", name: "Acme" });
    expect(JSON.stringify(listed)).not.toContain("BEGIN PUBLIC KEY");
    expect(listed[0]?.keyDigest).toMatch(/^[0-9a-f]{32}$/);
    await engine.shutdown();
  });

  it("refuses a non-Ed25519 key at registration rather than at install time", async () => {
    const { engine } = await fixture();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(engine.manifestTrust.addPublisher({
      id: "weak", name: "Weak", publicKey: rsa.publicKey.export({ type: "spki", format: "pem" }).toString(),
    })).rejects.toThrow(/Ed25519/);
    await expect(engine.manifestTrust.pin({ ...artifact, sha256: "not-a-digest" })).rejects.toThrow(/hex SHA-256/);
    await engine.shutdown();
  });

  it("blocks an install through the enforcement wrapper", async () => {
    const { engine } = await fixture();
    await engine.manifestTrust.configure({ tenantId: "tenant", requirePin: true });
    await expect(engine.manifestTrust.assertInstallable({ tenantId: "tenant", ...artifact }))
      .rejects.toThrow(/refused by manifest trust/);
    await engine.manifestTrust.pin(artifact);
    await expect(engine.manifestTrust.assertInstallable({ tenantId: "tenant", ...artifact })).resolves.toMatchObject({ allowed: true });
    await engine.shutdown();
  });
});

describe("Per-agent lifecycle hooks", () => {
  it("applies a subagent's declared hook only to sessions running under that profile", async () => {
    const { engine } = await fixture();
    const session = await engine.createSession({ tenantId: "tenant", name: "plain" });
    const snapshot = await engine.session(session.sessionId);
    await mkdir(join(snapshot.workspacePath, ".aurora", "agents"), { recursive: true });
    await writeFile(join(snapshot.workspacePath, ".aurora", "agents", "reader.md"), [
      "---",
      "name: reader",
      "description: Reads but never writes",
      "tools: filesystem.*",
      "hooks: tool.pre:deny:filesystem.write",
      "---",
      "Read only.",
    ].join("\n"), "utf8");

    const materialised = await engine.subagents.materialize({ tenantId: "tenant", workspacePath: snapshot.workspacePath, name: "reader" });
    expect(materialised.hookIds?.length).toBe(1);
    const rules = await engine.lifecycleHooks.rules("tenant", "tool.pre");
    expect(rules[0]?.agentProfileIds).toEqual([materialised.profile.id]);

    const context = (profileId?: string) => ({
      tenantId: "tenant", sessionId: session.sessionId, familyId: session.sessionId,
      turnId: "turn", toolCallId: `call-${Math.random()}`, source: "api" as const,
      workspacePath: snapshot.workspacePath, idempotencyKey: `agent-hook-${Math.random()}`,
      ...(profileId ? { agentProfileId: profileId } : {}),
    });

    // Under the agent's profile the declared hook denies the write…
    await expect(engine.capabilities.execute("filesystem.write", { path: "a.txt", content: "no" }, context(materialised.profile.id)))
      .rejects.toThrow(/reader/);
    // …and a session without that profile is untouched by it.
    await engine.sessionModes.set({ tenantId: "tenant", sessionId: session.sessionId, permissionMode: "acceptEdits", reason: "Test write path.", actor: "test" });
    await engine.capabilities.execute("filesystem.write", { path: "b.txt", content: "yes" }, context());
    await engine.shutdown();
  });
});
