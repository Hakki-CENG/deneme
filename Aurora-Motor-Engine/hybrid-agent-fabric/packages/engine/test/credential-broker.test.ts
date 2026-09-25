import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialBroker } from "../src/security/credential-broker.js";

describe("credential broker", () => {
  it("stores only AES-GCM ciphertext and issues scoped, bounded leases", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-credentials-"));
    const broker = new CredentialBroker(root, "test-master-key");
    const metadata = await broker.put({ tenantId: "tenant-a", name: "GITHUB_TOKEN", value: "super-secret-value" });
    const disk = await readFile(join(root, "credentials", "secrets.json"), "utf8");
    expect(disk).not.toContain("super-secret-value");
    expect(await broker.list("tenant-a")).toEqual([metadata]);

    const lease = await broker.issueLease({
      tenantId: "tenant-a",
      secretId: metadata.id,
      capabilityId: "github.issue.create",
      audience: "github-worker",
      maxUses: 1,
    });
    await expect(broker.redeemLease({
      leaseId: lease.leaseId,
      tenantId: "tenant-a",
      capabilityId: "wrong",
      audience: "github-worker",
    })).rejects.toThrow("scope mismatch");
    expect(await broker.redeemLease({
      leaseId: lease.leaseId,
      tenantId: "tenant-a",
      capabilityId: "github.issue.create",
      audience: "github-worker",
    })).toBe("super-secret-value");
    await expect(broker.redeemLease({
      leaseId: lease.leaseId,
      tenantId: "tenant-a",
      capabilityId: "github.issue.create",
      audience: "github-worker",
    })).rejects.toThrow("missing or already exhausted");
  });

  it("can decrypt after restart only with the same explicit master key", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-credentials-"));
    const first = new CredentialBroker(root, "stable-key");
    const secret = await first.put({ tenantId: "tenant", name: "API_TOKEN", value: "value" });
    const second = new CredentialBroker(root, "stable-key");
    const lease = await second.issueLease({ tenantId: "tenant", secretId: secret.id, capabilityId: "x", audience: "worker" });
    expect(await second.redeemLease({ leaseId: lease.leaseId, tenantId: "tenant", capabilityId: "x", audience: "worker" })).toBe("value");
  });
});
