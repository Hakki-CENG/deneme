/**
 * T4 — release reproducibility.
 *
 * Measured before this file existed: two consecutive `release:prepare` runs
 * produced different SHA256SUMS, because every artifact embedded the wall
 * clock and a fresh invocation id. The release tool already supported
 * SOURCE_DATE_EPOCH and a deterministic invocation id; what did not exist
 * was the proof. This test is that proof, pinned four ways:
 *
 *   - same epoch + same tree  → byte-identical checksums
 *   - different epoch         → different checksums (the epoch is not ignored)
 *   - changed tree            → different checksums (content is not ignored)
 *   - the pinned epoch lands in the artifacts themselves, not just the flags
 *
 * Without SOURCE_DATE_EPOCH the artifacts are wall-clock stamped by design —
 * an unsigned local build has nothing else to pin to, and pretending
 * otherwise would be the fabrication this repo does not do.
 *
 * The prepared project is a minimal fixture, not the repo itself: the
 * manifest hashes the whole tree, so hashing 10k files per run would make
 * this test measure disk speed instead of determinism. And the test drives
 * `prepareRelease()` in-process, not the built CLI — a src change must be
 * what fails this test, not a stale dist.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { prepareRelease } from "../src/release.js";

async function makeFixtureProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "t4-fixture-"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "repro-fixture", version: "1.0.0" }, null, 2)}\n`,
  );
  await writeFile(
    join(root, "package-lock.json"),
    `${JSON.stringify({ name: "repro-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "repro-fixture", version: "1.0.0" } } }, null, 2)}\n`,
  );
  await writeFile(join(root, "index.ts"), "export const answer = 42;\n");
  return root;
}

async function prepare(root: string, epoch: number, output: string): Promise<string> {
  await prepareRelease({ rootPath: root, outputPath: output, sourceDateEpoch: epoch });
  return await readFile(join(output, "SHA256SUMS"), "utf8");
}

const PINNED = 1761170000;
const PINNED_ISO = new Date(PINNED * 1000).toISOString();

describe("T4 — release reproducibility", () => {
  it("same epoch + same tree → identical SHA256SUMS across two runs", async () => {
    const root = await makeFixtureProject();
    // "out" is an excluded manifest segment, so the first run's output cannot
    // dirty the second run's input.
    const first = await prepare(root, PINNED, join(root, "out", "a"));
    const second = await prepare(root, PINNED, join(root, "out", "b"));
    expect(first).toBe(second);
  }, 120_000);

  it("a different epoch changes the checksums (the epoch is not ignored)", async () => {
    const root = await makeFixtureProject();
    const first = await prepare(root, PINNED, join(root, "out", "a"));
    const second = await prepare(root, PINNED + 1, join(root, "out", "b"));
    expect(first).not.toBe(second);
  }, 120_000);

  it("a changed tree changes the checksums (content is not ignored)", async () => {
    const root = await makeFixtureProject();
    const first = await prepare(root, PINNED, join(root, "out", "a"));
    await writeFile(join(root, "index.ts"), "export const answer = 43;\n");
    const second = await prepare(root, PINNED, join(root, "out", "b"));
    expect(first).not.toBe(second);
  }, 120_000);

  it("the pinned epoch is what the artifacts actually carry", async () => {
    const root = await makeFixtureProject();
    await prepare(root, PINNED, join(root, "out", "a"));
    const manifest = JSON.parse(await readFile(join(root, "out", "a", "source-manifest.json"), "utf8"));
    const provenance = JSON.parse(
      (await readFile(join(root, "out", "a", "provenance.intoto.jsonl"), "utf8")).trim(),
    );
    // The timestamps in the artifacts equal the pinned epoch — not the wall
    // clock that happened to be running when the test executed.
    expect(manifest.generatedAt).toBe(PINNED_ISO);
    expect(provenance.predicate.runDetails.metadata.startedOn).toBe(PINNED_ISO);
    expect(provenance.predicate.buildDefinition.externalParameters.sourceDateEpoch).toBe(PINNED);
    // The invocation id is derived (version-4-shaped from a hash), not random:
    // two pinned runs must agree on it, which the first test already proves
    // byte-for-byte. Here we pin its shape.
    expect(provenance.predicate.runDetails.metadata.invocationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  }, 120_000);
});
