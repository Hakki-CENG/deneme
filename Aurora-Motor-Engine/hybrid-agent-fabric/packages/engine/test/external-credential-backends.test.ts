import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultCredentialBroker } from "../src/security/vault-credential-broker.js";
import { KmsEnvelopeCredentialBroker, type KmsProvider } from "../src/security/kms-envelope-credential-broker.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("external credential backends", () => {
  it("stores values in Vault KV v2 while exposing metadata and scoped leases only", async () => {
    const vault = new Map<string, any>();
    globalThis.fetch = vi.fn(async (rawUrl, init) => {
      const url = new URL(String(rawUrl));
      const method = init?.method ?? "GET";
      expect((init?.headers as Record<string, string>)["x-vault-token"]).toBe("vault-token");
      if (method === "POST") {
        vault.set(url.pathname, JSON.parse(String(init?.body)).data);
        return new Response("{}", { status: 200 });
      }
      if (method === "LIST") {
        const prefix = url.pathname.replace("/metadata/", "/data/") + "/";
        const keys = [...vault.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
        return new Response(JSON.stringify({ data: { keys } }), { status: 200 });
      }
      if (method === "DELETE") {
        vault.delete(url.pathname.replace("/metadata/", "/data/"));
        return new Response(null, { status: 204 });
      }
      const data = vault.get(url.pathname);
      return data ? new Response(JSON.stringify({ data: { data } }), { status: 200 }) : new Response("{}", { status: 404 });
    }) as typeof fetch;
    const broker = new VaultCredentialBroker({ address: "https://vault.example.test", token: "vault-token" });
    const secret = await broker.put({ tenantId: "tenant", name: "API_TOKEN", value: "vault-secret", description: "token" });
    expect((await broker.list("tenant"))[0]).toEqual(secret);
    expect(JSON.stringify(await broker.list("tenant"))).not.toContain("vault-secret");
    const lease = await broker.issueLease({ tenantId: "tenant", secretId: secret.id, capabilityId: "x", audience: "worker" });
    expect(await broker.redeemLease({ leaseId: lease.leaseId, tenantId: "tenant", capabilityId: "x", audience: "worker" })).toBe("vault-secret");
    expect(await broker.remove("tenant", secret.id)).toBe(true);
  });

  it("uses envelope encryption with a pluggable KMS and zeroes plaintext data keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-kms-"));
    const master = Buffer.alloc(32, 0x5a);
    const kms: KmsProvider = {
      id: "fake-kms",
      async generateDataKey() {
        const plaintextKey = Buffer.alloc(32, 0x2a);
        const encryptedKey = Buffer.from(plaintextKey.map((value, index) => value ^ master[index]!));
        return { plaintextKey, encryptedKey };
      },
      async decryptDataKey(encryptedKey) {
        return Buffer.from(encryptedKey.map((value, index) => value ^ master[index]!));
      },
    };
    const broker = new KmsEnvelopeCredentialBroker(root, kms);
    const secret = await broker.put({ tenantId: "tenant", name: "DB_PASSWORD", value: "kms-secret" });
    const disk = await readFile(join(root, "credentials", "kms-envelopes.json"), "utf8");
    expect(disk).not.toContain("kms-secret");
    expect(disk).toContain("encryptedDataKey");
    const lease = await broker.issueLease({ tenantId: "tenant", secretId: secret.id, capabilityId: "db.query", audience: "db-worker" });
    expect(await broker.redeemLease({ leaseId: lease.leaseId, tenantId: "tenant", capabilityId: "db.query", audience: "db-worker" })).toBe("kms-secret");
  });
});
