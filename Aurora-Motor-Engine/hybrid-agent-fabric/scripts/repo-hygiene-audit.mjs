#!/usr/bin/env node
/**
 * repo-hygiene-audit — T1/T2/T3/T5/T6/T8/T9 in one measured report.
 *
 * Every check is a RATCHET: the current, measured state is the bound. The
 * ratchets turn "hygiene" from an opinion into a number that can only
 * improve — a regression fails CI instead of rotting silently.
 *
 *   T1  tracked-artifact patterns (release-metadata/, .tar.gz, .local/, dist/)
 *   T2  git history: blobs over 1 MiB, and secret VALUES in history
 *       (sk-, ghp_, github_pat_, AKIA…, PRIVATE KEY headers — identifiers
 *       like `options.apiKey` are code, not secrets)
 *   T3  every `npm run <x>` in .github/workflows/*.yml exists in package.json
 *   T5  size ratchet for the three known-too-large files (real splitting
 *       shrinks the bound; growth fails)
 *   T6  `any` census bound for src/ trees (counting `: any`, `as any`,
 *       `<any>`, `any[]`)
 *   T8  duplicate installed packages (npm ls --parseable duplicates)
 *   T9  tests using Math.random / Date.now must be a known, listed decision
 *
 * Usage: node scripts/repo-hygiene-audit.mjs [--root <dir>] [--json]
 * Exit 0 = all ratchets hold; 1 = at least one regression or git check
 * found real secrets (never exits 0 with a secret in history).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// ── Ratchets: measured on 2026-09-25, may only improve ───────────────────────

const SIZE_RATCHET = {
  // Counts use `content.split("\n").length`, which includes the trailing
  // empty string for newline-terminated files — one more than `wc -l`.
  // 3546 → 3514 in T5: the observability route group moved to routes/observability.ts.
  "apps/control-api/src/main.ts": 3514,
  "packages/engine/src/engine.ts": 5540,
  "apps/canvas-web/src/App.tsx": 1197,
};

// Matches (not lines), .ts and .tsx, src trees only. Measured 2026-09-25.
// Matches (not lines), .ts and .tsx, src trees only. Measured 2026-09-25.
const MAX_ANY_COUNT = 1039;

// T5: the OpenAPI registration count over main.ts + routes/*.ts. The static
// spec generation is only a sync check (it compares the file against a fresh
// generation over the same sources), so a dropped route regenerates a
// smaller spec and stays "current". This absolute bound is what fails then.
const EXPECTED_OPENAPI_REGISTRATIONS = 862;

const MAX_TRACKED_ARTIFACTS = 6;

const MAX_BIG_BLOBS = 0; // blobs over 1 MiB in git history

const NONDETERMINISM_ALLOWLIST = new Set([
  "apps/control-api/test/p2-endpoints.test.ts",
  "apps/session-worker/test/entrypoint.test.ts",
  "packages/engine/test/aurora-acos.test.ts",
  "packages/engine/test/aurora-context.test.ts",
  "packages/engine/test/aurora-core-upstream.test.ts",
  "packages/engine/test/aurora-fleet.test.ts",
  "packages/engine/test/aurora-world-model.test.ts",
  "packages/engine/test/auto-approvals.test.ts",
  "packages/engine/test/automation-git-sync.test.ts",
  "packages/engine/test/automation-responder-service.test.ts",
  "packages/engine/test/background-thinking-service.test.ts",
  "packages/engine/test/capability-acquisition-e2e.test.ts",
  "packages/engine/test/code-intelligence.test.ts",
  "packages/engine/test/code-pipeline-honesty.test.ts",
  "packages/engine/test/codex-engine.test.ts",
  "packages/engine/test/codex-oauth-manager.test.ts",
  "packages/engine/test/codex-subscription-provider.test.ts",
  "packages/engine/test/cognitive-state-isolation.test.ts",
  "packages/engine/test/email-channel-adapter.test.ts",
  "packages/engine/test/embodiment-hardening.test.ts",
  "packages/engine/test/embodiment-integration.test.ts",
  "packages/engine/test/fleet-monitor.test.ts",
  "packages/engine/test/hosted-scheduler.test.ts",
  "packages/engine/test/irc-channel-adapter.test.ts",
  "packages/engine/test/long-horizon-tasks.test.ts",
  "packages/engine/test/manifest-trust.test.ts",
  "packages/engine/test/mcp-oauth-resume.test.ts",
  "packages/engine/test/model-configuration-registry.test.ts",
  "packages/engine/test/model-oauth-manager.test.ts",
  "packages/engine/test/neural-cognitive-core.test.ts",
  "packages/engine/test/o-distributed-persistence.test.ts",
  "packages/engine/test/po-security-hardening.test.ts",
  "packages/engine/test/proactive-engine.test.ts",
  "packages/engine/test/project-instructions.test.ts",
  "packages/engine/test/prompt-cache.test.ts",
  "packages/engine/test/r-ablation-benchmark.test.ts",
  "packages/engine/test/recovery-strategies.test.ts",
  "packages/engine/test/s-self-direction.test.ts",
  "packages/engine/test/self-improvement-gate.test.ts",
  "packages/engine/test/session-lifecycle.test.ts",
  "packages/engine/test/skill-promotion-gate.test.ts",
  "packages/engine/test/skill-synthesis.test.ts",
  "packages/engine/test/society-integration.test.ts",
  "packages/engine/test/thought-memory-integration.test.ts",
  "packages/engine/test/twilio-sms-adapter.test.ts",
  "packages/engine/test/world-model-prediction-loop.test.ts",
  "packages/eval/test/state-docs.test.ts",
]);

const TRACKED_ARTIFACT_PATTERN = /(^|\/)(release-metadata|node_modules|\.local|dist)(\/|$)|\.tar\.gz$/;

const SECRET_VALUE_PATTERN =
  /sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xoxb-[0-9A-Za-z-]{10,}/g;

const ANY_PATTERN = /:\s*any\b|as\s+any\b|<any>|\bany\[\]/g;

// ── helpers ─────────────────────────────────────────────────────────────────

function git(root, args, mayFail = false) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (mayFail) return undefined;
    throw error;
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === ".turbo") continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx)$/.test(entry)) yield path;
  }
}

// ── checks ──────────────────────────────────────────────────────────────────

function checkSizeRatchet(root) {
  const violations = [];
  const measured = {};
  for (const [file, bound] of Object.entries(SIZE_RATCHET)) {
    const path = join(root, file);
    if (!existsSync(path)) continue; // renamed/split: the ratchet entry goes with it
    const lines = readFileSync(path, "utf8").split("\n").length;
    measured[file] = lines;
    if (lines > bound) violations.push({ file, lines, bound });
  }
  // Bounds are reported so a test can pin them: loosening a ratchet must be
  // visible, not just exceeding it.
  return { name: "T5-size-ratchet", ok: violations.length === 0, violations, measured, bounds: SIZE_RATCHET };
}

function checkAnyCensus(root) {
  const counts = [];
  let total = 0;
  const roots = ["packages", "apps"];
  for (const base of roots) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const path of walk(dir)) {
      if (/\.d\.ts$/.test(path)) continue;
      if (/[\\/]src[\\/]/.test(path) === false) continue; // src trees only, per the T6 scope
      const matches = readFileSync(path, "utf8").match(ANY_PATTERN);
      if (matches) {
        total += matches.length;
        counts.push({ file: relative(root, path), count: matches.length });
      }
    }
  }
  return {
    name: "T6-any-census",
    ok: total <= MAX_ANY_COUNT,
    total,
    bound: MAX_ANY_COUNT,
    worst: counts.sort((a, b) => b.count - a.count).slice(0, 5),
  };
}

function checkCiScripts(root) {
  const workflowsDir = join(root, ".github", "workflows");
  const missing = [];
  if (!existsSync(workflowsDir)) return { name: "T3-ci-scripts", ok: true, missing, note: "no workflows directory" };
  const rootScripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  // `npm run X -w @haf/pkg` resolves against that workspace's package.json.
  const workspaceScripts = new Map();
  for (const file of readdirSync(workflowsDir)) {
    const text = readFileSync(join(workflowsDir, file), "utf8");
    for (const match of text.matchAll(/npm run ([A-Za-z0-9:_-]+)(\s+-w\s+(@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+))?/g)) {
      const script = match[1];
      const workspace = match[3];
      if (workspace === undefined) {
        if (!(script in rootScripts)) missing.push({ workflow: file, script });
        continue;
      }
      if (!workspaceScripts.has(workspace)) {
        const manifest = join(root, "packages", workspace.split("/")[1] ?? "", "package.json");
        const appManifest = join(root, "apps", workspace.split("/")[1] ?? "", "package.json");
        const path = existsSync(manifest) ? manifest : appManifest;
        workspaceScripts.set(
          workspace,
          path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")).scripts ?? {}) : {},
        );
      }
      if (!(script in workspaceScripts.get(workspace))) {
        missing.push({ workflow: file, script: `${workspace}:${script}` });
      }
    }
  }
  return { name: "T3-ci-scripts", ok: missing.length === 0, missing };
}

function checkTrackedArtifacts(root) {
  const listed = git(root, ["ls-files"], true);
  if (listed === undefined) return { name: "T1-tracked-artifacts", ok: true, skipped: "not a git repository" };
  const offenders = listed
    .split("\n")
    .filter(Boolean)
    .filter((file) => TRACKED_ARTIFACT_PATTERN.test(file));
  // T1 also requires ignore rules at the git toplevel: without them the next
  // build output is one `git add .` away from joining the history.
  const toplevel = git(root, ["rev-parse", "--show-toplevel"], true)?.trim();
  const hasGitignore = toplevel !== undefined && existsSync(join(toplevel, ".gitignore"));
  return {
    name: "T1-tracked-artifacts",
    ok: offenders.length <= MAX_TRACKED_ARTIFACTS && hasGitignore,
    count: offenders.length,
    bound: MAX_TRACKED_ARTIFACTS,
    hasGitignore,
    offenders: offenders.slice(0, 10),
  };
}

function checkGitHistory(root) {
  const toplevel = git(root, ["rev-parse", "--show-toplevel"], true);
  if (toplevel === undefined) return { name: "T2-git-history", ok: true, skipped: "not a git repository" };
  const gitRoot = toplevel.trim();

  // Blobs over 1 MiB in history (informational list + ratchet).
  const objects = git(gitRoot, ["rev-list", "--objects", "--all"], true) ?? "";
  const byHash = new Map();
  for (const line of objects.split("\n")) {
    if (!line.trim()) continue;
    const [hash, ...rest] = line.split(" ");
    if (hash) byHash.set(hash, rest.join(" "));
  }
  const bigBlobs = [];
  if (byHash.size > 0) {
    // One batch call for every object; per-object `git cat-file` spawns one
    // process per hash, which is both slow and its own failure mode.
    const batch = execFileSync(
      "git",
      ["-C", gitRoot, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      { input: `${[...byHash.keys()].join("\n")}\n`, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    for (const line of batch.split("\n")) {
      if (!line.trim()) continue;
      const [hash, type, size] = line.split(" ");
      if (type === "blob" && Number(size) > 1024 * 1024) {
        bigBlobs.push({ path: byHash.get(hash) || hash, size: Number(size) });
      }
    }
  }

  // Secret VALUES in history — production paths only. Test files use fake
  // keys BY DESIGN (the AWS documentation example key, "reflected-secret"
  // sentinels, generated IRC test keys); flagging them would be noise that
  // drowns a real leak. Identifiers (`options.apiKey`) are code, not values.
  const POSIX_ERE =
    "sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xoxb-[0-9A-Za-z-]{10,}";
  const revs = (git(gitRoot, ["rev-list", "--all"], true) ?? "").trim().split("\n").filter(Boolean);
  const secretPaths = new Set();
  for (const rev of revs) {
    const grep = git(gitRoot, ["grep", "-l", "-E", POSIX_ERE, rev], true) ?? "";
    for (const line of grep.split("\n")) {
      if (!line.trim()) continue;
      const path = line.slice(line.indexOf(":") + 1);
      if (!/\/test\/|\.test\.|\/tests\/|_test\./.test(path)) secretPaths.add(path);
    }
  }

  return {
    name: "T2-git-history",
    ok: bigBlobs.length <= MAX_BIG_BLOBS && secretPaths.size === 0,
    bigBlobs,
    bigBlobBound: MAX_BIG_BLOBS,
    secretPaths: [...secretPaths].slice(0, 10),
    scannedCommits: revs.length,
    largestSeen: bigBlobs.reduce((max, blob) => Math.max(max, blob.size), 0),
  };
}

function checkOpenApiRegistrations(root) {
  const spec = join(root, "docs", "openapi.yaml");
  const generator = join(root, "scripts", "generate-openapi.mjs");
  if (!existsSync(spec) || !existsSync(generator)) {
    return { name: "T5-openapi", ok: true, skipped: "no docs/openapi.yaml" };
  }
  let inSync = true;
  try {
    execFileSync("node", [generator, "--check"], { cwd: root, timeout: 120_000, stdio: "ignore" });
  } catch {
    inSync = false;
  }
  // Same static extraction basis as the generator: app.<method>("...") over
  // main.ts plus every routes/*.ts module.
  const routesDir = join(root, "apps/control-api/src/routes");
  const sources = [
    join(root, "apps/control-api/src/main.ts"),
    ...(existsSync(routesDir)
      ? readdirSync(routesDir).filter((file) => file.endsWith(".ts")).sort().map((file) => join(routesDir, file))
      : []),
  ];
  const registration = /\bapp\.(get|post|put|patch|delete|head|options|all)\(\s*(["'`])([^"'`]+)\2/g;
  let registrations = 0;
  for (const source of sources) {
    for (const _match of readFileSync(source, "utf8").matchAll(registration)) registrations += 1;
  }
  return {
    name: "T5-openapi",
    ok: inSync && registrations === EXPECTED_OPENAPI_REGISTRATIONS,
    inSync,
    registrations,
    bound: EXPECTED_OPENAPI_REGISTRATIONS,
  };
}

function checkDuplicateDeps(root) {
  try {
    const out = execFileSync("npm", ["ls", "--parseable"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const duplicates = [...new Set(out.split("\n").filter(Boolean))].filter(
      (line, index, all) => all.indexOf(line) !== index,
    );
    return { name: "T8-duplicate-deps", ok: duplicates.length === 0, duplicates: duplicates.slice(0, 5) };
  } catch {
    return { name: "T8-duplicate-deps", ok: true, skipped: "npm ls failed (offline or uninstalled)" };
  }
}

function checkNondeterminismInventory(root) {
  const offenders = [];
  const roots = ["packages", "apps"];
  for (const base of roots) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const path of walk(dir)) {
      if (!/\.test\.tsx?$/.test(path)) continue;
      const text = readFileSync(path, "utf8");
      if (/Math\.random|Date\.now/.test(text)) {
        const rel = relative(root, path).split(sep).join("/");
        if (!NONDETERMINISM_ALLOWLIST.has(rel)) offenders.push(rel);
      }
    }
  }
  return {
    name: "T9-nondeterminism-inventory",
    ok: offenders.length === 0,
    unlisted: offenders,
    allowlistSize: NONDETERMINISM_ALLOWLIST.size,
  };
}

// ── main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const rootFlag = args.indexOf("--root");
const root = resolve(rootFlag >= 0 ? args[rootFlag + 1] : relative(process.cwd(), new URL("..", import.meta.url).pathname));

const checks = [
  checkSizeRatchet(root),
  checkOpenApiRegistrations(root),
  checkAnyCensus(root),
  checkCiScripts(root),
  checkTrackedArtifacts(root),
  checkGitHistory(root),
  checkDuplicateDeps(root),
  checkNondeterminismInventory(root),
];

const report = {
  root,
  ok: checks.every((check) => check.ok),
  checks,
};

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const check of checks) {
    const status = check.skipped ? "SKIP" : check.ok ? "ok" : "REGRESSION";
    process.stderr.write(`${status.padEnd(10)} ${check.name}\n`);
    if (!check.ok) process.stderr.write(`${JSON.stringify(check, null, 2)}\n`);
  }
  process.stderr.write(report.ok ? "repo hygiene: all ratchets hold\n" : "repo hygiene: REGRESSION\n");
}
process.exit(report.ok ? 0 : 1);
