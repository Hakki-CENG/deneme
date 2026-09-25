/**
 * Federated data-policy enforcement.
 *
 * `checkResidency()` used to `return true` unconditionally, so the
 * `data_residency` branch of `checkDataPolicy()` could never fire — the rule
 * was configurable, enforceable, and completely inert.
 *
 * Four of the six `DataPolicyRule` types (`encrypt_at_rest`,
 * `encrypt_in_transit`, `retention`, `anonymize`) are still not evaluated by
 * this method. They are now reported through `unenforceable` instead of being
 * silently dropped, so an operator can tell the difference between "checked and
 * compliant" and "never checked".
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FederatedService } from "../src/federated/federated-service.js";

async function service(): Promise<FederatedService> {
  const root = await mkdtemp(join(tmpdir(), "haf-federated-"));
  return new FederatedService(root);
}

describe("data residency rules can actually fail", () => {
  it("flags a target outside the allowed region", async () => {
    const federated = await service();
    await federated.createDataPolicy("t", "EU only", "Data must stay in the EU", [
      {
        type: "data_residency",
        description: "EU only",
        parameters: { allowedRegions: ["eu-west-1", "eu-central-1"] },
        enforced: true,
      },
    ]);

    const result = await federated.checkDataPolicy("t", "store", "s3://bucket/us-east-1/data");

    expect(result.allowed).toBe(false);
    expect(result.violations.join(" ")).toContain("residency");
  });

  it("permits a target inside the allowed region", async () => {
    const federated = await service();
    await federated.createDataPolicy("t", "EU only", "Data must stay in the EU", [
      {
        type: "data_residency",
        description: "EU only",
        parameters: { allowedRegions: ["eu-west-1"] },
        enforced: true,
      },
    ]);

    const result = await federated.checkDataPolicy("t", "store", "s3://bucket/eu-west-1/data");

    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("blocks an explicitly blocked region even when others are allowed", async () => {
    const federated = await service();
    await federated.createDataPolicy("t", "No CN", "Never store in cn-north", [
      {
        type: "data_residency",
        description: "No CN",
        parameters: { blockedRegions: ["cn-north-1"] },
        enforced: true,
      },
    ]);

    const blocked = await federated.checkDataPolicy("t", "store", "db://cn-north-1/table");
    const fine = await federated.checkDataPolicy("t", "store", "db://eu-west-1/table");

    expect(blocked.allowed).toBe(false);
    expect(fine.allowed).toBe(true);
  });

  it("treats an enforced residency rule with no parameters as misconfigured, not compliant", async () => {
    const federated = await service();
    await federated.createDataPolicy("t", "Empty", "Operator forgot the parameters", [
      {
        type: "data_residency",
        description: "Empty",
        parameters: {},
        enforced: true,
      },
    ]);

    const result = await federated.checkDataPolicy("t", "store", "s3://bucket/eu-west-1/data");

    // Silently passing would hide the misconfiguration.
    expect(result.allowed).toBe(false);
  });

  it("ignores rules that are not enforced", async () => {
    const federated = await service();
    await federated.createDataPolicy("t", "Advisory", "Not enforced yet", [
      {
        type: "data_residency",
        description: "Advisory",
        parameters: { allowedRegions: ["eu-west-1"] },
        enforced: false,
      },
    ]);

    const result = await federated.checkDataPolicy("t", "store", "s3://bucket/us-east-1/data");

    expect(result.allowed).toBe(true);
  });
});

describe("rule types with no implementation are declared, not hidden", () => {
  it("reports an enforced encrypt_at_rest rule as unenforceable", async () => {
    const federated = await service();
    await federated.createDataPolicy("t", "Encryption", "Must encrypt at rest", [
      {
        type: "encrypt_at_rest",
        description: "AES-256",
        parameters: {},
        enforced: true,
      },
    ]);

    const result = await federated.checkDataPolicy("t", "store", "s3://bucket/data");

    expect(result.unenforceable).toHaveLength(1);
    expect(result.unenforceable[0]).toContain("encrypt_at_rest");
    // It is not a violation — we simply cannot vouch for it.
    expect(result.violations).toHaveLength(0);
  });

  it("still enforces the rules it does implement alongside unenforceable ones", async () => {
    const federated = await service();
    await federated.createDataPolicy("t", "Mixed", "Cloud ban plus retention", [
      { type: "no_cloud", description: "No cloud", parameters: {}, enforced: true },
      { type: "retention", description: "90 days", parameters: { days: 90 }, enforced: true },
    ]);

    const result = await federated.checkDataPolicy("t", "store", "cloud://provider/bucket");

    expect(result.allowed).toBe(false);
    expect(result.violations.join(" ")).toContain("Cloud");
    expect(result.unenforceable.join(" ")).toContain("retention");
  });
});
