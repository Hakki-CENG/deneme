/**
 * T1/T2/T3/T5/T6/T8/T9 — repo hygiene ratchets.
 *
 * Two layers:
 *   1. The real repository must pass `scripts/repo-hygiene-audit.mjs` today.
 *      Every ratchet is bound to the current measured state, so any growth
 *      (a bigger main.ts, a new `any`, an unlisted nondeterministic test)
 *      fails here instead of rotting silently.
 *   2. A synthetic fixture repository must produce exactly the findings it
 *      was built to contain — proving the audit detects what it claims to
 *      detect, which a green run on a clean repo alone cannot prove.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const AUDIT = join(ROOT, "scripts", "repo-hygiene-audit.mjs");

interface AuditReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; [key: string]: unknown }>;
}

function runAudit(root: string): { code: number; report: AuditReport } {
  try {
    const stdout = execFileSync("node", [AUDIT, "--root", root, "--json"], {
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    const stdout = String((error as { stdout?: string }).stdout ?? "");
    return { code: (error as { status?: number }).status ?? 1, report: JSON.parse(stdout) };
  }
}

function check(report: AuditReport, name: string) {
  return report.checks.find((item) => item.name === name);
}

describe("repo hygiene audit — the real repository", () => {
  it(
    "every ratchet holds today",
    async () => {
      const { code, report } = runAudit(ROOT);
      expect(report.ok).toBe(true);
      expect(code).toBe(0);
      const failed = report.checks.filter((item) => !item.ok).map((item) => item.name);
      expect(failed).toEqual([]);
    },
    240_000,
  );

  it(
    "the ratchets measure what they claim: known counts appear in the report",
    async () => {
      const { report } = runAudit(ROOT);
      // T5: the three big files are bounded at their measured sizes — and
      // the BOUNDS themselves are pinned, so loosening a ratchet is caught,
      // not just exceeding it.
      const size = check(report, "T5-size-ratchet") as {
        violations: unknown[];
        bounds: Record<string, number>;
        measured: Record<string, number>;
      };
      expect(size.violations).toEqual([]);
      expect(size.bounds).toEqual({
        "apps/control-api/src/main.ts": 3514,
        "packages/engine/src/engine.ts": 5540,
        "apps/canvas-web/src/App.tsx": 1197,
      });
      expect(size.measured["apps/control-api/src/main.ts"]).toBeLessThanOrEqual(3514);

      // T5: the OpenAPI registration count is pinned exactly.
      const openapi = check(report, "T5-openapi") as { registrations: number; bound: number; inSync: boolean };
      expect(openapi.inSync).toBe(true);
      expect(openapi.registrations).toBe(862);
      expect(openapi.bound).toBe(862);

      // T6: the any census is a real count with a pinned bound, not a stub.
      const census = check(report, "T6-any-census") as { total: number; bound: number; worst: Array<{ file: string }> };
      expect(census.total).toBeGreaterThan(0);
      expect(census.bound).toBe(1039);
      expect(census.total).toBeLessThanOrEqual(census.bound);
      expect(census.worst[0]?.file).toContain("App.tsx");

      // T9: the nondeterminism inventory knows the allowlist size.
      const inventory = check(report, "T9-nondeterminism-inventory") as { allowlistSize: number; unlisted: unknown[] };
      expect(inventory.allowlistSize).toBe(47);
      expect(inventory.unlisted).toEqual([]);

      // T1: ignore rules exist at the git toplevel and the tracked-artifact
      // count is pinned at its measured bound.
      const tracked = check(report, "T1-tracked-artifacts") as { hasGitignore: boolean; count: number; bound: number };
      expect(tracked.hasGitignore).toBe(true);
      expect(tracked.count).toBeLessThanOrEqual(6);

      // T2: history was actually scanned.
      const history = check(report, "T2-git-history") as { scannedCommits: number; secretPaths: unknown[] };
      expect(history.scannedCommits).toBeGreaterThan(0);
      expect(history.secretPaths).toEqual([]);
    },
    240_000,
  );
});

describe("repo hygiene audit — a fixture repository proves detection", () => {
  async function makeDirtyFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "t-hygiene-fixture-"));

    // A git repo with history: one big blob (over 1 MiB), one production
    // secret, one benign test fixture.
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await mkdir(join(root, "packages", "demo", "src"), { recursive: true });
    await mkdir(join(root, "packages", "demo", "test"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { build: "tsc" } }, null, 2)}\n`,
    );
    await writeFile(
      join(root, ".github", "workflows", "ci.yml"),
      "jobs:\n  x:\n    steps:\n      - run: npm run build\n      - run: npm run does-not-exist\n",
    );
    await writeFile(join(root, "packages", "demo", "src", "index.ts"), "const x: any = 1; const y: any = 2;\n");
    await writeFile(join(root, "packages", "demo", "src", "big.bin"), "B".repeat(2 * 1024 * 1024));
    await writeFile(
      join(root, "packages", "demo", "src", "config.ts"),
      'export const token = "AKIAIOSFODNN7EXAMPLEREAL";\n',
    );
    await writeFile(
      join(root, "packages", "demo", "test", "fixtures.test.ts"),
      'const fake = "AKIAIOSFODNN7EXAMPLEFAKE";\n',
    );
    // main.ts sized to breach a ratchet? No: the size ratchet is bound to the
    // real repo's files; the fixture only exercises detection of the rest.
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "fixture"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "fixture", "--no-gpg-sign"], { cwd: root });
    return root;
  }

  it(
    "a dirty fixture fails the audit with exactly the expected findings",
    async () => {
      const root = await makeDirtyFixture();
      const { code, report } = runAudit(root);
      expect(code).toBe(1);
      expect(report.ok).toBe(false);

      // T3: ci.yml references a script that does not exist.
      const ci = check(report, "T3-ci-scripts") as { missing: Array<{ script: string }> };
      expect(ci.ok).toBe(false);
      expect(ci.missing.map((item) => item.script)).toContain("does-not-exist");

      // T2: the >1 MiB blob and the production secret are found; the test
      // fixture's fake key is NOT a finding.
      const history = check(report, "T2-git-history") as { bigBlobs: Array<{ path: string }>; secretPaths: string[] };
      expect(history.ok).toBe(false);
      expect(history.bigBlobs.some((blob) => blob.path.includes("big.bin"))).toBe(true);
      expect(history.secretPaths.some((path) => path.includes("src/config.ts"))).toBe(true);
      expect(history.secretPaths.some((path) => path.includes("fixtures.test.ts"))).toBe(false);

      // T6: the two `any`s in src are counted.
      const census = check(report, "T6-any-census") as { total: number; bound: number };
      expect(census.total).toBe(2);

      // T9: an unlisted clock-using test would be a finding (none here).
      const inventory = check(report, "T9-nondeterminism-inventory") as { unlisted: unknown[] };
      expect(inventory.ok).toBe(true);

      // T5: the fixture repo has no ratcheted files; the check must not
      // crash on their absence.
      const size = check(report, "T5-size-ratchet") as { violations: unknown[] };
      expect(size.ok).toBe(true);
    },
    240_000,
  );

  it(
    "an unlisted nondeterministic test is a finding, a listed one is not",
    async () => {
      const root = await makeDirtyFixture();
      // Not in the allowlist: a NEW test file using the clock. The literal is
      // assembled from parts so this test file's own source does not contain
      // the token and flag itself in the T9 inventory.
      const clock = ["Date", "now()"].join(".");
      await writeFile(
        join(root, "packages", "demo", "test", "brand-new.test.ts"),
        `const t = ${clock};\n`,
      );
      const { report } = runAudit(root);
      const inventory = check(report, "T9-nondeterminism-inventory") as { unlisted: string[] };
      expect(inventory.unlisted).toContain("packages/demo/test/brand-new.test.ts");
    },
    240_000,
  );
});
