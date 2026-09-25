import type { SandboxFactory } from "../sandbox/sandbox.js";
import { auroraDigest, auroraInteger, auroraRound, auroraText } from "../util/aurora-state.js";

const MAX_FILES = 500;
const MAX_DIFF_CHARS = 200_000;

export interface ReviewFileChange {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed" | "untracked";
  addedLines: number;
  removedLines: number;
  binary: boolean;
}

export interface ReviewFinding {
  severity: "info" | "warning" | "critical";
  code: string;
  path?: string;
  detail: string;
}

export interface WorkingTreeReview {
  workspacePath: string;
  base: string;
  scope: "working-tree" | "staged" | "base-branch";
  branch?: string;
  files: ReviewFileChange[];
  findings: ReviewFinding[];
  stats: { files: number; added: number; removed: number; binaryFiles: number; largestFile?: string };
  diffExcerpt: string;
  diffTruncated: boolean;
  digest: string;
  generatedAt: string;
}

/** Deterministic checks. None of these need a model, and all of them are cheap to justify. */
const SECRET_PATTERNS: Array<{ code: string; pattern: RegExp; detail: string }> = [
  { code: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/, detail: "An AWS access key id appears in the diff." },
  { code: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, detail: "A private key block appears in the diff." },
  { code: "bearer-token", pattern: /\b(?:bearer|authorization)\s*[:=]\s*['"]?[A-Za-z0-9._-]{20,}/i, detail: "A bearer token or authorization header value appears in the diff." },
  { code: "generic-secret", pattern: /\b(api[_-]?key|secret[_-]?key|client[_-]?secret|password)\s*[:=]\s*['"][^'"\s]{12,}['"]/i, detail: "A hard-coded credential-looking assignment appears in the diff." },
  { code: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, detail: "A Slack token appears in the diff." },
];

const SENSITIVE_PATHS = [
  { code: "env-file", pattern: /(^|\/)\.env(\.|$)/i, detail: "An environment file is part of this change." },
  { code: "ci-workflow", pattern: /(^|\/)\.github\/workflows\//i, detail: "A CI workflow is part of this change; it can run with repository credentials." },
  { code: "infrastructure", pattern: /(^|\/)(terraform|k8s|kubernetes|helm|deploy)\//i, detail: "Infrastructure definitions are part of this change." },
  { code: "production-config", pattern: /production|prod\.(json|ya?ml|toml|env)/i, detail: "A production configuration file is part of this change." },
];

const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/i;
const MANIFESTS = /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|requirements\.txt)$/i;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|cs|kt|swift)$/i;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;

/**
 * Working-tree review — the `/review` the peers ship, done without asking a model first.
 *
 * A review that starts with an LLM summarising a diff is a review that can be talked out of its own
 * findings. This service produces the *evidence* an agent or a human then reasons about: what changed,
 * how much, and which deterministic checks fired. Every finding here is mechanical — a regex over the
 * added lines, a path pattern, a ratio — so it is reproducible and cannot be argued away.
 *
 * Bounded by construction: file count, diff characters and command output are all capped, binary files
 * are counted rather than dumped, and the git commands run through the same sandbox factory every
 * other git capability uses, so a review inherits the session's confinement.
 */
export class WorkingTreeReviewService {
  constructor(private readonly factory: SandboxFactory, private readonly now: () => number = Date.now) {}

  async review(input: { workspacePath: string; base?: string; staged?: boolean; maxFiles?: number; maxDiffChars?: number; signal?: AbortSignal }): Promise<WorkingTreeReview> {
    const workspacePath = auroraText(input.workspacePath, 4096, "Workspace path");
    const maxFiles = auroraInteger(input.maxFiles ?? MAX_FILES, 1, 5000, "Review file limit");
    const maxDiffChars = auroraInteger(input.maxDiffChars ?? MAX_DIFF_CHARS, 1000, 2_000_000, "Review diff limit");
    const base = input.base ? branchish(input.base) : undefined;
    const scope: WorkingTreeReview["scope"] = base ? "base-branch" : input.staged ? "staged" : "working-tree";

    const range = base ? `${base}...HEAD` : input.staged ? "--cached" : "";
    const numstat = await this.git(workspacePath, `git diff --no-ext-diff --numstat ${range}`.trim(), input.signal);
    const nameStatus = await this.git(workspacePath, `git diff --no-ext-diff --name-status ${range}`.trim(), input.signal);
    const diff = await this.git(workspacePath, `git diff --no-ext-diff ${range}`.trim(), input.signal, maxDiffChars);
    const branch = (await this.git(workspacePath, "git rev-parse --abbrev-ref HEAD", input.signal)).trim() || undefined;
    const untracked = scope === "working-tree"
      ? (await this.git(workspacePath, "git ls-files --others --exclude-standard", input.signal)).split("\n").map((line) => line.trim()).filter(Boolean)
      : [];

    const statusByPath = new Map<string, ReviewFileChange["change"]>();
    for (const line of nameStatus.split("\n")) {
      const [code, ...rest] = line.trim().split(/\s+/);
      const path = rest.at(-1);
      if (!code || !path) continue;
      statusByPath.set(path, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified");
    }

    const files: ReviewFileChange[] = [];
    for (const line of numstat.split("\n")) {
      const parts = line.trim().split(/\t/);
      if (parts.length < 3) continue;
      const [added, removed, path] = parts as [string, string, string];
      if (files.length >= maxFiles) break;
      const binary = added === "-" || removed === "-";
      files.push({
        path,
        change: statusByPath.get(path) ?? "modified",
        addedLines: binary ? 0 : Number(added) || 0,
        removedLines: binary ? 0 : Number(removed) || 0,
        binary,
      });
    }
    for (const path of untracked) {
      if (files.length >= maxFiles) break;
      files.push({ path, change: "untracked", addedLines: 0, removedLines: 0, binary: false });
    }

    const addedLines = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    const findings = this.analyse(files, addedLines.join("\n"), scope);
    const largest = [...files].sort((a, b) => (b.addedLines + b.removedLines) - (a.addedLines + a.removedLines))[0];

    return {
      workspacePath,
      base: base ?? (scope === "staged" ? "index" : "working tree"),
      scope,
      ...(branch ? { branch } : {}),
      files,
      findings,
      stats: {
        files: files.length,
        added: files.reduce((sum, item) => sum + item.addedLines, 0),
        removed: files.reduce((sum, item) => sum + item.removedLines, 0),
        binaryFiles: files.filter((item) => item.binary).length,
        ...(largest ? { largestFile: largest.path } : {}),
      },
      diffExcerpt: diff.slice(0, maxDiffChars),
      diffTruncated: diff.length >= maxDiffChars,
      digest: auroraDigest(diff),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  private analyse(files: ReviewFileChange[], addedText: string, scope: WorkingTreeReview["scope"]): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    for (const secret of SECRET_PATTERNS) {
      if (secret.pattern.test(addedText)) {
        findings.push({ severity: "critical", code: secret.code, detail: secret.detail });
      }
    }
    for (const file of files) {
      for (const sensitive of SENSITIVE_PATHS) {
        if (sensitive.pattern.test(file.path)) {
          findings.push({ severity: "warning", code: sensitive.code, path: file.path, detail: sensitive.detail });
        }
      }
    }

    const lockfiles = files.filter((item) => LOCKFILES.test(item.path));
    const manifests = files.filter((item) => MANIFESTS.test(item.path));
    if (lockfiles.length && !manifests.length) {
      findings.push({
        severity: "warning",
        code: "lockfile-without-manifest",
        path: lockfiles[0]!.path,
        detail: "A dependency lockfile changed without its manifest; the dependency set may have moved unintentionally.",
      });
    }

    const sourceFiles = files.filter((item) => SOURCE_FILE.test(item.path) && !TEST_FILE.test(item.path) && item.change !== "deleted");
    const testFiles = files.filter((item) => TEST_FILE.test(item.path));
    if (sourceFiles.length >= 2 && !testFiles.length) {
      findings.push({
        severity: "info",
        code: "no-test-changes",
        detail: `${sourceFiles.length} source file(s) changed with no test file touched.`,
      });
    }

    const removed = files.reduce((sum, item) => sum + item.removedLines, 0);
    const added = files.reduce((sum, item) => sum + item.addedLines, 0);
    if (removed > 200 && removed > added * 3) {
      findings.push({
        severity: "warning",
        code: "large-deletion",
        detail: `${removed} lines removed against ${added} added; confirm this is a deliberate deletion, not a bad merge.`,
      });
    }
    if (files.length > 60) {
      findings.push({ severity: "info", code: "large-change", detail: `${files.length} files in one change; consider splitting it for review.` });
    }
    if (scope === "working-tree" && files.some((item) => item.change === "untracked")) {
      findings.push({
        severity: "info",
        code: "untracked-files",
        detail: `${files.filter((item) => item.change === "untracked").length} untracked file(s) are present and will not be part of a commit unless added.`,
      });
    }
    if (!files.length) {
      findings.push({ severity: "info", code: "no-changes", detail: "Nothing to review: the selected scope is clean." });
    }
    return findings;
  }

  private async git(workspacePath: string, command: string, signal?: AbortSignal, maxOutputChars = 500_000): Promise<string> {
    const sandbox = await this.factory(workspacePath);
    try {
      const result = await sandbox.exec({ command, timeoutMs: 120_000, maxOutputChars, ...(signal ? { signal } : {}) });
      if (result.exitCode !== 0) {
        // A clean tree, a missing base branch or a non-repository are all "no output", not a crash:
        // a review must degrade to "nothing to review" rather than take the turn down with it.
        return "";
      }
      return result.stdout;
    } finally {
      await sandbox.destroy();
    }
  }
}

/** Accepts a branch, tag or commit-ish, and refuses anything that could smuggle shell syntax. */
function branchish(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) || name.includes("..") || name.includes("//")) {
    throw new Error("Review base must be a plain branch, tag or commit reference.");
  }
  return name;
}

/** Compact severity rollup, used by the CLI and Canvas so they agree on what "clean" means. */
export function reviewVerdict(review: WorkingTreeReview): { verdict: "clean" | "review" | "blocked"; critical: number; warnings: number } {
  const critical = review.findings.filter((item) => item.severity === "critical").length;
  const warnings = review.findings.filter((item) => item.severity === "warning").length;
  return {
    verdict: critical ? "blocked" : warnings ? "review" : "clean",
    critical,
    warnings,
  };
}

/** Exported for tests: the ratio helper used in the large-deletion check. */
export function deletionRatio(added: number, removed: number): number {
  return added === 0 ? removed : auroraRound(removed / Math.max(1, added));
}
