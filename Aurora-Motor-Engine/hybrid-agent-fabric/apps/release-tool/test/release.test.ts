import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareRelease, verifyRelease } from "../src/release.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "haf-release-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "var", "data"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { dependency: "1.2.3" } }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({
    name: "fixture", version: "1.0.0", lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0", dependencies: { dependency: "1.2.3" } },
      "node_modules/dependency": { name: "dependency", version: "1.2.3", license: "MIT" },
    },
  }));
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(join(root, ".env"), "SECRET=raw-secret\n");
  await writeFile(join(root, ".env.example"), "SECRET=\n");
  await writeFile(join(root, "node_modules", "dependency", "index.js"), "ignored");
  await writeFile(join(root, "dist", "bundle.js"), "ignored");
  await writeFile(join(root, "var", "data", "secrets.json"), "raw-secret");
  await writeFile(join(root, "artifact.tar.gz"), "artifact-bytes");
  return root;
}

describe("SBOM and provenance release tooling", () => {
  it("produces deterministic CycloneDX/SPDX/provenance while excluding generated and sensitive trees", async () => {
    const root = await fixture(), output = join(root, "release-metadata");
    const first = await prepareRelease({ rootPath: root, outputPath: output, artifacts: ["artifact.tar.gz"], sourceDateEpoch: 1_700_000_000, builderId: "test-builder" });
    const manifest1 = await readFile(join(output, "source-manifest.json"), "utf8");
    const provenance1 = await readFile(join(output, "provenance.intoto.jsonl"), "utf8");
    const second = await prepareRelease({ rootPath: root, outputPath: output, artifacts: ["artifact.tar.gz"], sourceDateEpoch: 1_700_000_000, builderId: "test-builder" });
    expect(await readFile(join(output, "source-manifest.json"), "utf8")).toBe(manifest1);
    expect(await readFile(join(output, "provenance.intoto.jsonl"), "utf8")).toBe(provenance1);
    const manifest = JSON.parse(manifest1);
    const paths = manifest.entries.map((entry: any) => entry.path);
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain(".env.example");
    expect(paths).not.toContain(".env");
    expect(paths.every((path: string) => !path.startsWith("node_modules/") && !path.startsWith("dist/") && !path.startsWith("var/") && !path.startsWith("release-metadata/"))).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain("raw-secret");
    const cyclone = JSON.parse(await readFile(join(output, "sbom.cyclonedx.json"), "utf8"));
    expect(cyclone.specVersion).toBe("1.5");
    expect(cyclone.components).toContainEqual(expect.objectContaining({ name: "dependency", version: "1.2.3", purl: "pkg:npm/dependency@1.2.3" }));
    const spdx = JSON.parse(await readFile(join(output, "sbom.spdx.json"), "utf8"));
    expect(spdx.spdxVersion).toBe("SPDX-2.3");
    expect(spdx.packages).toContainEqual(expect.objectContaining({ name: "dependency", licenseDeclared: "MIT" }));
    const provenance = JSON.parse(provenance1);
    expect(provenance.predicateType).toBe("https://slsa.dev/provenance/v1");
    expect(provenance.predicate.runDetails.builder.id).toBe("test-builder");
    expect(first.checksums).toEqual(second.checksums);
    expect(await readFile(join(output, "artifacts", "artifact.tar.gz"), "utf8")).toBe("artifact-bytes");
    expect(await verifyRelease(output)).toMatchObject({ valid: true, signature: "absent" });
  });

  it("creates and verifies Ed25519 checksum attestations and detects tampering", async () => {
    const root = await fixture(), output = join(root, "release-metadata");
    const { privateKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const result = await prepareRelease({ rootPath: root, outputPath: output, sourceDateEpoch: 1_700_000_000, signingPrivateKeyPem: privatePem });
    expect(result.signed).toBe(true);
    expect(await verifyRelease(output)).toMatchObject({ valid: true, signature: "valid" });
    const envelope = await readFile(join(output, "attestation.ed25519.json"), "utf8");
    expect(envelope).not.toContain("PRIVATE KEY");
    await writeFile(join(output, "sbom.cyclonedx.json"), "{}\n");
    await expect(verifyRelease(output)).rejects.toThrow("Checksum mismatch");
  });

  it("rejects output escape, invalid signing keys and duplicate artifact names", async () => {
    const root = await fixture();
    await expect(prepareRelease({ rootPath: root, outputPath: join(root, "..", "outside") })).rejects.toThrow("escapes");
    await expect(prepareRelease({ rootPath: root, outputPath: join(root, "release-metadata"), signingPrivateKeyPem: "bad" })).rejects.toThrow();
    const other = await mkdtemp(join(tmpdir(), "haf-artifact-"));
    await writeFile(join(other, "artifact.tar.gz"), "different");
    await expect(prepareRelease({ rootPath: root, outputPath: join(root, "release-metadata"), artifacts: ["artifact.tar.gz", join(other, "artifact.tar.gz")] })).rejects.toThrow("duplicate basename");
  });
});
