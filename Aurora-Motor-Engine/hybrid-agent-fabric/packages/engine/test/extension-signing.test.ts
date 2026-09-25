/**
 * Extension signing has to be able to say "no".
 *
 * `signExtension()` used to store a `randomUUID()` as the signature and
 * `verifySignature()` returned `!!extension.signature` -- so any non-empty
 * string verified, including the random one it had just written. A signature
 * that cannot fail is not a signature.
 *
 * These tests pin the half that matters: a real Ed25519 signature verifies, and
 * tampering, an unregistered key, a revoked key and an unsigned extension all
 * fail.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentSDKService, type Extension } from "../src/sdk/agent-sdk-service.js";

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

/**
 * Edit the persisted state directly.
 *
 * The service exposes no content-update API, so the only way to change what a
 * signed extension does is to tamper with the file it is stored in -- which is
 * exactly the attack a signature has to defeat.
 */
async function tamperStoredExtension(extensionId: string, patch: (e: Record<string, unknown>) => void): Promise<void> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const file = join(dir, "agent-sdk.json");
  const state = JSON.parse(await readFile(file, "utf8")) as { extensions: Record<string, unknown>[] };
  const target = state.extensions.find((e) => e.id === extensionId);
  if (!target) throw new Error(`extension ${extensionId} not in stored state`);
  patch(target);
  await writeFile(file, JSON.stringify(state), "utf8");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "haf-sign-"));
  sdk = new AgentSDKService(dir);
  await sdk.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a real signature verifies", () => {
  it("signs with Ed25519 and verifies against the registered trust root", async () => {
    const extension = await sdk.registerExtension(TENANT, extensionInput());
    const key = await sdk.generateSigningKey("test");

    const record = await sdk.signExtension(extension.id, key.privateKey);

    expect(record.algorithm).toBe("ed25519");
    expect(record.keyId).toBe(key.keyId);
    expect(record.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await sdk.verifySignature(extension.id)).toBe(true);
  });

  it("produces a signature that is not a random identifier", async () => {
    // The regression this whole file exists for: a UUID is unique but proves
    // nothing, and it verified under the old check.
    const extension = await sdk.registerExtension(TENANT, extensionInput());
    const key = await sdk.generateSigningKey("test");

    const record = await sdk.signExtension(extension.id, key.privateKey);

    expect(record.value).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // Signing the same bytes twice is deterministic under Ed25519.
    const again = await sdk.signExtension(extension.id, key.privateKey);
    expect(again.value).toBe(record.value);
  });
});

describe("verification fails when it should", () => {
  it("fails after the extension is modified", async () => {
    const extension = await sdk.registerExtension(TENANT, extensionInput());
    const key = await sdk.generateSigningKey("test");
    await sdk.signExtension(extension.id, key.privateKey);
    expect(await sdk.verifySignature(extension.id)).toBe(true);

    // Change what the extension does. The signature covers the manifest, so this
    // must break verification -- otherwise signing proves nothing about content.
    await tamperStoredExtension(extension.id, (e) => {
      const manifest = e.manifest as { entrypoint: string };
      manifest.entrypoint = "malicious.js";
    });
    // Reload so the service sees the tampered bytes rather than its own cache.
    const reopened = new AgentSDKService(dir);
    await reopened.init();

    expect(await reopened.verifySignature(extension.id)).toBe(false);
  });

  it("fails for an unsigned extension by default", async () => {
    const extension = await sdk.registerExtension(TENANT, extensionInput());

    expect(await sdk.verifySignature(extension.id)).toBe(false);
  });

  it("does not accept a bare legacy signature string", async () => {
    // Exactly what the old code produced and accepted.
    const extension = await sdk.registerExtension(TENANT, extensionInput());
    await tamperStoredExtension(extension.id, (e) => {
      e.signature = "11111111-2222-3333-4444-555555555555";
    });
    const reopened = new AgentSDKService(dir);
    await reopened.init();

    expect(await reopened.verifySignature(extension.id)).toBe(false);
  });

  it("fails once the signing key is revoked", async () => {
    const extension = await sdk.registerExtension(TENANT, extensionInput());
    const key = await sdk.generateSigningKey("test");
    await sdk.signExtension(extension.id, key.privateKey);
    expect(await sdk.verifySignature(extension.id)).toBe(true);

    await sdk.revokeSigningKey(key.keyId);

    expect(await sdk.verifySignature(extension.id)).toBe(false);
  });

  it("fails for an unknown extension", async () => {
    expect(await sdk.verifySignature("does-not-exist")).toBe(false);
  });

  it("honours an explicit allowUnsigned opt-out", async () => {
    const extension = await sdk.registerExtension(TENANT, extensionInput());
    await sdk.updateConfig({ allowUnsigned: true });

    expect(await sdk.verifySignature(extension.id)).toBe(true);
  });
});

describe("the trust root is enforced", () => {
  it("refuses to sign with a key that is not registered", async () => {
    const extension = await sdk.registerExtension(TENANT, extensionInput());
    // A perfectly valid Ed25519 key that this platform has never been told about.
    const outsider = await sdk.generateSigningKey("outsider");
    await sdk.revokeSigningKey(outsider.keyId);

    // The key is known but no longer trusted, so signing must refuse rather than
    // produce a signature that verification would then reject.
    await expect(sdk.signExtension(extension.id, outsider.privateKey)).rejects.toThrow(/was revoked/);
  });

  it("refuses to sign with a key the platform has never been told about", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("ed25519");
    const extension = await sdk.registerExtension(TENANT, extensionInput());

    await expect(
      sdk.signExtension(extension.id, privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    ).rejects.toThrow(/not a registered trust root/);
  });

  it("rejects a trust root that is not Ed25519", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

    await expect(sdk.addTrustRoot(pem)).rejects.toThrow(/must be an Ed25519 key/);
  });

  it("accepts an externally generated Ed25519 public key", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyId = await sdk.addTrustRoot(publicKey.export({ type: "spki", format: "pem" }).toString());

    const extension = await sdk.registerExtension(TENANT, extensionInput());
    const record = await sdk.signExtension(
      extension.id,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );

    expect(record.keyId).toBe(keyId);
    expect(await sdk.verifySignature(extension.id)).toBe(true);
  });
});
