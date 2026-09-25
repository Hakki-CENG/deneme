#!/usr/bin/env node
/**
 * Build the release source bundle from the file list in `source-manifest.json`.
 *
 * The bundle that shipped with the 1.38.0 metadata contained 376 entries while
 * its own manifest listed 310 — the two were produced by different, undocumented
 * procedures, so nothing tied the artifact to the attestation. There was no
 * script that built it at all.
 *
 * Building the tarball *from the manifest* makes the relationship checkable: the
 * archive holds exactly the files the SLSA provenance covers, no more and no
 * less. `--verify` re-reads the archive and fails if it disagrees.
 *
 * Determinism: entries are sorted, mtimes come from SOURCE_DATE_EPOCH, and
 * ownership is normalised, so the same tree hashes identically on any host.
 *
 * Usage:
 *   SOURCE_DATE_EPOCH=1790035200 node scripts/build-source-bundle.mjs [--verify]
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PARENT = dirname(ROOT);
const PREFIX = basename(ROOT); // archives carry a single top-level directory
const MANIFEST = join(ROOT, "release-metadata", "source-manifest.json");
const OUT = join(PARENT, `${PREFIX}-source.tar.gz`);

const verify = process.argv.includes("--verify");
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? 0);
if (!Number.isFinite(epoch) || epoch <= 0) {
  console.error("SOURCE_DATE_EPOCH must be set to a positive unix timestamp for a reproducible bundle.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const entries = [...manifest.entries].sort((a, b) => a.path.localeCompare(b.path));
const listFile = join(PARENT, `.${PREFIX}-bundle-list.txt`);

// tar reads the file list from stdin via -T -; write it out so the invocation is
// auditable and identical on every run.
const listed = entries.map((entry) => `${PREFIX}/${entry.path}`).join("\n");
const { writeFileSync, rmSync, existsSync } = await import("node:fs");
writeFileSync(listFile, `${listed}\n`);

if (verify) {
  // `--quoting-style=literal` keeps non-ASCII file names intact; without it tar
  // octal-escapes them (S\304\260STEM) and every Turkish-named file at the repo
  // root looks like a mismatch.
  const actual = execFileSync(
    "tar",
    ["--quoting-style=literal", "--list", `--file=${OUT}`, "--gzip"],
    { cwd: PARENT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\n")
    .filter((line) => line && !line.endsWith("/"))
    .sort();
  const expected = entries.map((entry) => `${PREFIX}/${entry.path}`).sort();
  const missing = expected.filter((path) => !actual.includes(path));
  const extra = actual.filter((path) => !expected.includes(path));
  rmSync(listFile, { force: true });
  if (missing.length > 0 || extra.length > 0) {
    console.error(
      `Bundle does not match the manifest.\n` +
        `  missing from archive: ${missing.length}${missing.slice(0, 5).map((p) => `\n    ${p}`).join("")}\n` +
        `  extra in archive    : ${extra.length}${extra.slice(0, 5).map((p) => `\n    ${p}`).join("")}`,
    );
    process.exit(1);
  }
  console.log(`Bundle matches the manifest: ${expected.length} files in ${PREFIX}-source.tar.gz`);
  process.exit(0);
}

// `..` is the working directory so archived paths carry the top-level prefix.
execFileSync(
  "tar",
  [
    "--create",
    `--file=${OUT}`,
    `--gzip`,
    `--mtime=@${epoch}`,
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--no-recursion",
    `--files-from=${listFile}`,
  ],
  { cwd: PARENT, stdio: ["ignore", "ignore", "inherit"] },
);
rmSync(listFile, { force: true });

const { statSync } = await import("node:fs");
const size = statSync(OUT).size;
console.log(
  `Wrote ${OUT}\n` +
    `  files  : ${entries.length} (from release-metadata/source-manifest.json)\n` +
    `  bytes  : ${size}\n` +
    `  mtime  : @${epoch}`,
);
