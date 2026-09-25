#!/usr/bin/env node
/**
 * Repository invariant verifier.
 *
 * This replaces the old root-level `verify-integration.ts`, which had rotted:
 *
 *  - It hardcoded `const BASE = "/home/user/Aurora-Motor-Engine/hybrid-agent-fabric"`,
 *    so it failed on every machine except the one it was written on.
 *  - 29 of its 71 checks failed because they asserted that 12 route files still
 *    existed; those files had been deliberately deleted.
 *  - It searched `main.ts` for the literal `version: "1.64.0"`, i.e. it failed the
 *    code for doing the right thing (`version.ts` is documented as "never hardcode
 *    version strings") and passed a hardcoded string.
 *  - Every check was `fileExists(...)` or `fileContains(...)`. A grep for a string
 *    proves the string is present, not that anything is wired up.
 *  - Nothing invoked it: no package.json script, no CI step.
 *
 * What is here instead measures properties that can actually be false, and each
 * one is a regression that has already happened in this repo:
 *
 *  1. workspace-versions          11 package.json files drifting apart
 *  2. spec-version                docs/openapi.yaml claiming another release
 *  3. no-hardcoded-product-version  1.38.0 / 1.61.0 literals in identity fields
 *  4. openapi-current             7 documented paths against 844 registered
 *  5. release-metadata-fresh      SLSA/SBOM attesting 1.38.0 with 310 of 1437 files
 *  6. node-version-agreement      engines >=20 vs CI 20 vs desktop >=22.12
 *  7. workspace-test-coverage     a workspace silently having no test script
 *  8. engine-version-runtime      the built engine reporting the wrong version
 *
 * Exit code is 1 if any check fails. `--json` prints machine-readable results.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
}

/** Remove block and line comments so prose is not mistaken for code. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

function workspacePackageFiles() {
  const files = ["package.json"];
  for (const group of ["packages", "apps"]) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const candidate = join(dir, entry, "package.json");
      if (existsSync(candidate)) files.push(`${group}/${entry}/package.json`);
    }
  }
  return files;
}

function walkSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walkSourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const rootPackage = readJson("package.json");
const productVersion = rootPackage.version;

// ── 1. Workspace versions ─────────────────────────────────────────────────────
{
  const files = workspacePackageFiles();
  const mismatched = files
    .map((file) => ({ file, version: readJson(file).version }))
    .filter((entry) => entry.version !== productVersion);
  record(
    "workspace-versions",
    mismatched.length === 0,
    mismatched.length === 0
      ? `${files.length} package.json files all at ${productVersion}`
      : `expected ${productVersion}, found: ${mismatched.map((m) => `${m.file}=${m.version}`).join(", ")}`,
  );
}

// ── 2. OpenAPI spec version ───────────────────────────────────────────────────
{
  const spec = readFileSync(join(ROOT, "docs", "openapi.yaml"), "utf8");
  const match = /^\s*version:\s*(\S+)\s*$/m.exec(spec);
  const specVersion = match?.[1];
  record(
    "spec-version",
    specVersion === productVersion,
    specVersion === productVersion
      ? `docs/openapi.yaml info.version is ${specVersion}`
      : `docs/openapi.yaml declares ${specVersion}, package.json is ${productVersion}`,
  );
}

// ── 3. No hardcoded product version in source ─────────────────────────────────
{
  // Product releases have reached 1.38+; capability/skill schema versions are
  // 0.1.0 / 1.0.0 / 1.1.0 / 2.0.0 and must stay independent, so the pattern only
  // matches release-shaped numbers. This is the literal that was hardcoded in six
  // files (ACP agentInfo, control-api serviceVersion, headless clientInfo,
  // release-tool builderId + SBOM creator, OTLP service.version, MCP clientInfo).
  const pattern = /"(1\.(?:3[89]|[4-9]\d)\.\d+[^"]*)"/g;
  const offenders = [];
  for (const group of ["apps", "packages"]) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const ws of readdirSync(dir)) {
      const src = join(dir, ws, "src");
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;
      for (const file of walkSourceFiles(src)) {
        const code = stripComments(readFileSync(file, "utf8"));
        for (const match of code.matchAll(pattern)) {
          offenders.push(`${file.slice(ROOT.length + 1)} → ${match[1]}`);
        }
      }
    }
  }
  record(
    "no-hardcoded-product-version",
    offenders.length === 0,
    offenders.length === 0
      ? "no release-shaped version literal in any src/ file (identity comes from package.json)"
      : `hardcoded product version(s): ${offenders.join(", ")}`,
  );
}

// ── 4. OpenAPI spec matches the registered routes ─────────────────────────────
{
  try {
    const output = execFileSync(process.execPath, [join(ROOT, "scripts", "generate-openapi.mjs"), "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    record("openapi-current", true, output.trim().split("\n")[0]);
  } catch (error) {
    record("openapi-current", false, `${(error.stderr || error.message || "").toString().trim().split("\n")[0]} — run \`npm run docs:openapi\``);
  }
}

// ── 5. Release metadata attests the current tree ──────────────────────────────
{
  const manifestPath = join(ROOT, "release-metadata", "source-manifest.json");
  const builderPath = join(ROOT, "apps", "release-tool", "dist", "release.js");
  if (!existsSync(manifestPath)) {
    record("release-metadata-fresh", false, "release-metadata/source-manifest.json is missing");
  } else if (!existsSync(builderPath)) {
    record("release-metadata-fresh", false, "apps/release-tool is not built — run `npm run build -w @haf/release-tool`");
  } else {
    const committed = JSON.parse(readFileSync(manifestPath, "utf8"));
    const { buildSourceManifest } = await import(pathToFileURL(builderPath).href);
    const current = await buildSourceManifest(ROOT, rootPackage.name, productVersion, committed.generatedAt);
    const problems = [];
    if (committed.project?.version !== productVersion) {
      problems.push(`manifest attests ${committed.project?.version}, tree is ${productVersion}`);
    }
    if (committed.aggregateSha256 !== current.aggregateSha256) {
      problems.push(`content hash differs (${committed.entries?.length} attested entries vs ${current.entries.length} now)`);
    }
    record(
      "release-metadata-fresh",
      problems.length === 0,
      problems.length === 0
        ? `attestation matches the tree at ${productVersion} (${current.entries.length} files)`
        : `${problems.join("; ")} — regenerate with \`npm run release:prepare\``,
    );
  }
}

// ── 5b. Attestation covers no gitignored file ─────────────────────────────────
{
  // The release tool walks the filesystem and keeps its own exclusion list, so it
  // can fall behind .gitignore. It did: 580 of 1453 attested entries were files
  // git does not track, 552 of them generated eval outputs rewritten on every
  // `npm run eval:gates`. The SLSA statement was attesting throwaway state, and
  // running the gates invalidated the attestation.
  //
  // This uses git rather than re-reading .gitignore so the guard stays correct
  // when the ignore rules change. New source that is merely unstaged is NOT
  // flagged — only files git deliberately ignores.
  const manifestPath = join(ROOT, "release-metadata", "source-manifest.json");
  if (!existsSync(manifestPath)) {
    record("attestation-excludes-generated", false, "release-metadata/source-manifest.json is missing");
  } else {
    let ignored;
    try {
      ignored = new Set(
        execFileSync(
          "git",
          ["-c", "core.quotepath=false", "ls-files", "--others", "--ignored", "--exclude-standard"],
          { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        ).split("\n").filter(Boolean),
      );
    } catch {
      ignored = undefined;
    }
    if (ignored === undefined) {
      record("attestation-excludes-generated", false, "git is unavailable, cannot cross-check the manifest");
    } else {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const leaked = manifest.entries.map((e) => e.path).filter((path) => ignored.has(path));
      record(
        "attestation-excludes-generated",
        leaked.length === 0,
        leaked.length === 0
          ? `all ${manifest.entries.length} attested files are source git does not ignore`
          : `${leaked.length} gitignored file(s) in the attestation, e.g. ${leaked.slice(0, 3).join(", ")}`,
      );
    }
  }
}

// ── 6. Node version agreement ─────────────────────────────────────────────────
{
  const engines = rootPackage.engines?.node ?? "";
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const major = (text) => [...text.matchAll(/(\d{2})(?:\.\d+)?/g)].map((m) => Number(m[1]));
  const ciMajors = [...new Set(major([...ci.matchAll(/node-version:\s*(\S+)/g)].map((m) => m[1]).join(" ")))];
  const dockerMajors = [...new Set(major([...dockerfile.matchAll(/FROM node:(\S+)/g)].map((m) => m[1]).join(" ")))];
  const enginesMajor = major(engines);
  const consistent =
    enginesMajor.length === 1 &&
    ciMajors.length === 1 &&
    dockerMajors.length === 1 &&
    enginesMajor[0] === ciMajors[0] &&
    enginesMajor[0] === dockerMajors[0];
  record(
    "node-version-agreement",
    consistent,
    consistent
      ? `engines, CI and Dockerfile all pin Node ${enginesMajor[0]}`
      : `engines="${engines}" CI=[${ciMajors}] Dockerfile=[${dockerMajors}]`,
  );
}

// ── 7. Every workspace has a test script ──────────────────────────────────────
{
  // The root `test` script used to name seven workspaces by hand, so a workspace
  // that gained tests was silently never run. A workspace with no tests of its
  // own must say where it is covered instead ("haf:testedBy"), so the exception
  // is recorded rather than silently assumed — apps/wasi-runner is a 24-line
  // launcher exercised by @haf/engine's wasi-plugin.test.ts, which spawns its
  // built dist/main.js.
  const files = workspacePackageFiles().slice(1); // skip the root
  const untested = [];
  const coveredElsewhere = [];
  const byName = new Map(files.map((file) => [readJson(file).name, file]));
  for (const file of files) {
    const pkg = readJson(file);
    if (pkg.scripts?.test) continue;
    const testedBy = pkg["haf:testedBy"];
    if (testedBy && byName.has(testedBy) && readJson(byName.get(testedBy)).scripts?.test) {
      coveredElsewhere.push(`${pkg.name} (via ${testedBy})`);
      continue;
    }
    untested.push(testedBy ? `${file} (claims ${testedBy}, which has no test script)` : file);
  }
  record(
    "workspace-test-coverage",
    untested.length === 0,
    untested.length === 0
      ? `${files.length - coveredElsewhere.length} workspaces test themselves; ${coveredElsewhere.length || "none"} covered elsewhere${coveredElsewhere.length ? `: ${coveredElsewhere.join(", ")}` : ""}`
      : `no test script and no valid haf:testedBy: ${untested.join(", ")}`,
  );
}

// ── 7b. Hand-written status docs carry a staleness banner ─────────────────────
//
// README documents that CURRENT_STATE.md / MATURITY_MATRIX.md / KNOWN_GAPS.md
// are generated and that state-docs.test.ts catches drift. Hand-written status
// documents sit outside that discipline and contradict the generated ones (one
// claimed "production-ready" while MATURITY_MATRIX reports zero modules at
// production, another claims "612 test" against a measured 1589). They are
// historical records, so they are kept, but each must point readers at the
// authoritative files.

const MARKER = "<!-- HAF-STATUS-BANNER -->";

/**
 * What makes a document a *status* document rather than a description.
 *
 * Deliberately narrow, and each alternative is a claim that has been measured
 * false in this repo at some point:
 *
 *   production-ready            6 docs said it while MATURITY_MATRIX reports
 *                               zero modules at production
 *   %NN complete / %NN tamam    "%85 complete", "%50 tamamlanmış"
 *   TAMAMLANDI                  filename-level completion claims
 *   ✅ Tüm                       "✅ Tüm P0, P1 ve P2 sorunları çözüldü"
 *   NNN test/tests/endpoint/...  "612 test", "130 endpoints", "563 endpoint",
 *                               "196 tests" — measured values are elsewhere
 *
 * What is *not* here, on purpose:
 *   "N satır"      an analysis document legitimately says "App.tsx is 1196
 *                  satır"; that is a description of a file, not a status claim.
 *                  Including it made `docs/reference-analysis.md` (a 2732-line
 *                  analysis) report 10 "claims".
 *   "tamamlandı"   `docs/API.md` documents an event named `task:completed`
 *                  whose description reads "Görev tamamlandı". Requiring the
 *                  all-caps `TAMAMLANDI` form keeps the heading without
 *                  catching prose.
 */
const STATUS_CLAIM =
  /production-ready|%[\d]+\s*(?:complete|tamamlan)|\bTAMAMLANDI\b|✅\s*T[üu]m\b|\d{3,}\s*(?:test|tests|endpoint|mod[üu]l|capability|yetenek|panel)\b/i;

/** Header line the state-docs generator writes into everything it produces. */
const GENERATED_BY = /Generated:.*docs:state/;

/**
 * Hand-written status documents that must carry a staleness banner.
 *
 * This used to be a hardcoded array of 10 paths, and the check passed with it —
 * while five status documents in the same tree carried no banner at all, three
 * of them in `docs/`. A hardcoded list proves the ten files it names are
 * bannered; it says nothing about the eleventh, which is the only one that ever
 * appears without one.
 *
 * So the list is derived: scan the trees that hold status documents, skip what
 * the generator produced, and report anything that makes a status claim without
 * pointing readers at the authoritative files.
 */
/** @returns {{ path: string, claims: string[] }[]} */
function handWrittenStatusDocs() {
  const found = [];
  for (const relative of [".", "docs", ".."]) {
    let entries;
    try {
      entries = readdirSync(join(ROOT, relative));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const full = join(ROOT, relative, entry);
      if (!statSync(full).isFile()) continue;
      const text = readFileSync(full, "utf8");
      if (text.includes(MARKER)) continue;
      if (GENERATED_BY.test(text.split("\n").slice(0, 8).join("\n"))) continue;
      const claims = text.match(new RegExp(STATUS_CLAIM, "gi"));
      if (claims) found.push({ path: join(relative, entry), claims });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
{
  const unbannnered = handWrittenStatusDocs();
  record(
    "status-docs-banner",
    unbannnered.length === 0,
    unbannnered.length === 0
      ? "every hand-written status doc found in the repo points readers at the generated state files"
      : `no staleness banner: ${unbannnered
          .map((doc) => `${doc.path} (claims e.g. "${doc.claims[0]}")`)
          .join(", ")}`,
  );
}

// ── 8. Built engine reports the real version ──────────────────────────────────
{
  const engineEntry = join(ROOT, "packages", "engine", "dist", "index.js");
  if (!existsSync(engineEntry)) {
    record("engine-version-runtime", false, "packages/engine is not built — run `npm run build -w @haf/engine`");
  } else {
    const engine = await import(pathToFileURL(engineEntry).href);
    record(
      "engine-version-runtime",
      engine.ENGINE_VERSION === productVersion,
      engine.ENGINE_VERSION === productVersion
        ? `built engine reports ${engine.ENGINE_VERSION} (read from package.json at runtime)`
        : `built engine reports ${engine.ENGINE_VERSION}, package.json is ${productVersion}`,
    );
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
if (asJson) {
  process.stdout.write(`${JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2)}\n`);
} else {
  for (const result of results) {
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.id}\n      ${result.detail}\n`);
  }
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
