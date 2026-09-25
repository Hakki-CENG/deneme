import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialBroker } from "../src/security/credential-broker.js";
import { SecretSourceRegistry } from "../src/security/secret-source-registry.js";

const previous = process.env.TEST_SOURCE_TOKEN;
afterEach(() => {
  if (previous === undefined) delete process.env.TEST_SOURCE_TOKEN;
  else process.env.TEST_SOURCE_TOKEN = previous;
});

async function executable(root: string, body: string) {
  const path = join(root, "source.sh");
  const content = `#!/bin/sh\n${body}\n`;
  await writeFile(path, content); await chmod(path, 0o700);
  return { path, sha256: createHash("sha256").update(content).digest("hex") };
}

describe("pinned external secret sources", () => {
  it("imports values through a pinned command without exposing references or values", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-secret-source-"));
    const command = await executable(root, "printf '%s:%s' \"$1\" \"$TEST_SOURCE_TOKEN\"");
    process.env.TEST_SOURCE_TOKEN = "external-value";
    const broker = new CredentialBroker(root, "master");
    const registry = new SecretSourceRegistry(root, broker);
    const source = await registry.add({
      name: "command source", kind: "command", executable: command.path, executableSha256: command.sha256,
      args: ["{reference}"], environmentVariables: ["TEST_SOURCE_TOKEN"],
      items: [{ secretName: "IMPORTED_TOKEN", reference: "vault/reference", description: "Imported" }],
    });
    expect(JSON.stringify(source)).not.toContain("vault/reference");
    expect(JSON.stringify(source)).not.toContain("external-value");
    const refreshed = await registry.refresh(source.id, "tenant");
    expect(refreshed.failures).toEqual([]);
    expect(refreshed.imported[0]?.name).toBe("IMPORTED_TOKEN");
    expect(JSON.stringify(refreshed)).not.toContain("external-value");
    const metadata = (await broker.list("tenant"))[0]!;
    const lease = await broker.issueLease({ tenantId: "tenant", secretId: metadata.id, capabilityId: "test", audience: "test" });
    expect(await broker.redeemLease({ leaseId: lease.leaseId, tenantId: "tenant", capabilityId: "test", audience: "test" })).toBe("vault/reference:external-value");
    expect(JSON.stringify(await registry.list())).not.toContain("vault/reference");
  });

  it("uses fixed 1Password/Bitwarden argument contracts and rejects executable replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-secret-source-cli-"));
    const command = await executable(root, "printf '%s' \"$*\"");
    const broker = new CredentialBroker(root, "master");
    const registry = new SecretSourceRegistry(root, broker);
    const op = await registry.add({
      name: "op", kind: "onepassword", executable: command.path, executableSha256: command.sha256,
      items: [{ secretName: "OP_SECRET", reference: "op://vault/item/password" }],
    });
    await registry.refresh(op.id, "tenant");
    const opMeta = (await broker.list("tenant")).find((item) => item.name === "OP_SECRET")!;
    const opLease = await broker.issueLease({ tenantId: "tenant", secretId: opMeta.id, capabilityId: "test", audience: "test" });
    expect(await broker.redeemLease({ leaseId: opLease.leaseId, tenantId: "tenant", capabilityId: "test", audience: "test" })).toBe("read op://vault/item/password --no-newline");
    await writeFile(command.path, "#!/bin/sh\nprintf tampered\n");
    await expect(registry.refresh(op.id, "tenant")).rejects.toThrow("SHA-256 verification failed");
  });
});
