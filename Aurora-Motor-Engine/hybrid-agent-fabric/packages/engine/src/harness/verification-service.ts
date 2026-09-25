import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { SandboxFactory } from "../sandbox/sandbox.js";
import { DurableJsonState, auroraInteger, auroraText } from "../util/aurora-state.js";

const MAX_RECORDS = 500;
const MAX_OUTPUT_TAIL = 4000;
const DEFAULT_PHASE_TIMEOUT_MS = 10 * 60_000;

export type VerificationPhase = "bootstrap" | "build" | "test" | "lint";

export interface VerificationRecipe {
  /** Human label, e.g. "Node (npm)". */
  name: string;
  /** Detector id: node, python, go, rust, java, make, unknown. */
  kind: string;
  bootstrap: string[];
  build: string[];
  test: string[];
  lint: string[];
  /** Files that made the detector fire, so a wrong guess is debuggable rather than mysterious. */
  evidence: string[];
}

export interface VerificationPhaseResult {
  phase: VerificationPhase;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  outputTail: string;
  passed: boolean;
}

export interface VerificationRun {
  id: string;
  tenantId: string;
  sessionId: string;
  workspacePath: string;
  recipe: VerificationRecipe;
  phases: VerificationPhaseResult[];
  /** `verified` only when every phase that ran passed and at least one test or build phase ran. */
  verdict: "verified" | "failed" | "inconclusive";
  reason: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sequence: number;
}

interface VerificationStateShape {
  schemaVersion: 1;
  runs: VerificationRun[];
  sequence: number;
}

function isState(value: unknown): value is VerificationStateShape {
  const candidate = value as VerificationStateShape | undefined;
  return Boolean(candidate && candidate.schemaVersion === 1 && Array.isArray(candidate.runs));
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true).catch(() => false);
}

/**
 * Project verification: run the project's own checks and keep the evidence.
 *
 * Aurora could plan work, execute it, review the diff and record how confident it felt. What it could
 * not do is the thing a human reviewer does first: **run the project's own build and tests, and keep
 * the receipt.** Peers ship this as a first-class subsystem, and the reason is the failure mode it
 * removes - an agent declaring "done" on the strength of having written some code.
 *
 * The design commitments:
 *
 * - **the commands come from the project, not from us.** Detection reads lockfiles, manifests and
 *   script tables and runs what the repository already defines. Inventing a build command for someone
 *   else's project is how an agent ends up "verifying" nothing.
 * - **detection is explainable.** Every recipe carries the files that produced it, so a wrong guess is
 *   a visible wrong guess.
 * - **`verified` is a high bar.** Every phase that ran must have passed, and a run that executed no
 *   build or test phase is `inconclusive`, never `verified`. Silence is not evidence.
 * - **evidence is durable and bounded.** Each run stores the command, exit code, duration and a
 *   bounded output tail, so "prove it" is answerable after the session ends without keeping megabytes.
 * - **execution reuses the sandbox.** Same confinement, same environment scrubbing, same resource
 *   limits as every other command Aurora runs.
 */
export class VerificationService {
  private readonly state: DurableJsonState<VerificationStateShape>;

  constructor(
    rootPath: string,
    private readonly factory: SandboxFactory,
    private readonly now: () => number = Date.now,
  ) {
    this.state = new DurableJsonState<VerificationStateShape>(
      resolvePath(rootPath, "verification", "runs.json"),
      () => ({ schemaVersion: 1, runs: [], sequence: 0 }),
      isState,
      "Verification state",
    );
  }

  /** Detect what this project verifies itself with. Read-only and cheap enough to call per turn. */
  async detect(workspacePath: string): Promise<VerificationRecipe> {
    const evidence: string[] = [];
    const has = async (name: string) => {
      const found = await exists(join(workspacePath, name));
      if (found) evidence.push(name);
      return found;
    };

    const packageJsonPath = join(workspacePath, "package.json");
    if (await has("package.json")) {
      const manifest = await readJson(packageJsonPath) ?? {};
      const scripts = (manifest["scripts"] ?? {}) as Record<string, string>;
      // Lockfiles decide the package manager: running npm in a pnpm repo is a good way to produce a
      // failure that has nothing to do with the agent's change.
      const manager = (await has("pnpm-lock.yaml")) ? "pnpm"
        : (await has("yarn.lock")) ? "yarn"
        : (await has("bun.lockb")) ? "bun"
        : "npm";
      const run = (script: string) => manager === "npm" ? `npm run ${script}` : `${manager} run ${script}`;
      await has("package-lock.json");
      return {
        name: `Node (${manager})`,
        kind: "node",
        bootstrap: [manager === "npm" ? "npm ci || npm install" : `${manager} install`],
        build: scripts["build"] ? [run("build")] : [],
        test: scripts["test"] ? [run("test")] : [],
        lint: [scripts["typecheck"] ? run("typecheck") : "", scripts["lint"] ? run("lint") : ""].filter(Boolean),
        evidence,
      };
    }

    if ((await has("pyproject.toml")) || (await has("requirements.txt")) || (await has("setup.py"))) {
      const usesUv = await has("uv.lock");
      const usesPoetry = await has("poetry.lock");
      const prefix = usesUv ? "uv run " : usesPoetry ? "poetry run " : "";
      return {
        name: usesUv ? "Python (uv)" : usesPoetry ? "Python (poetry)" : "Python",
        kind: "python",
        bootstrap: usesUv ? ["uv sync"] : usesPoetry ? ["poetry install"] : (await exists(join(workspacePath, "requirements.txt")) ? ["pip install -r requirements.txt"] : []),
        build: [],
        test: [`${prefix}pytest -q`],
        lint: [`${prefix}ruff check .`],
        evidence,
      };
    }

    if (await has("go.mod")) {
      return { name: "Go", kind: "go", bootstrap: ["go mod download"], build: ["go build ./..."], test: ["go test ./..."], lint: ["go vet ./..."], evidence };
    }
    if (await has("Cargo.toml")) {
      return { name: "Rust", kind: "rust", bootstrap: [], build: ["cargo build"], test: ["cargo test"], lint: ["cargo clippy -- -D warnings"], evidence };
    }
    if (await has("pom.xml")) {
      return { name: "Java (Maven)", kind: "java", bootstrap: [], build: ["mvn -q -B compile"], test: ["mvn -q -B test"], lint: [], evidence };
    }
    if ((await has("build.gradle")) || (await has("build.gradle.kts"))) {
      return { name: "Java (Gradle)", kind: "java", bootstrap: [], build: ["./gradlew assemble"], test: ["./gradlew test"], lint: [], evidence };
    }
    if (await has("Makefile")) {
      const makefile = await readFile(join(workspacePath, "Makefile"), "utf8").catch(() => "");
      const targets = new Set([...makefile.matchAll(/^([A-Za-z0-9_.-]+):/gm)].map((match) => match[1]!));
      return {
        name: "Make",
        kind: "make",
        bootstrap: [],
        build: targets.has("build") ? ["make build"] : [],
        test: targets.has("test") ? ["make test"] : [],
        lint: targets.has("lint") ? ["make lint"] : [],
        evidence,
      };
    }

    const entries = await readdir(workspacePath).catch(() => [] as string[]);
    return {
      name: "Unknown project",
      kind: "unknown",
      bootstrap: [], build: [], test: [], lint: [],
      evidence: entries.slice(0, 10),
    };
  }

  /**
   * Run the recipe's phases in order and record the evidence. Stops at the first failing phase: a test
   * suite run against a build that did not compile answers a question nobody asked.
   */
  async run(input: {
    tenantId: string;
    sessionId: string;
    workspacePath: string;
    phases?: VerificationPhase[];
    commands?: Partial<Record<VerificationPhase, string[]>>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<VerificationRun> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const sessionId = auroraText(input.sessionId, 200, "Session ID");
    const recipe = await this.detect(input.workspacePath);
    const requested = input.phases?.length ? input.phases : (["build", "test"] as VerificationPhase[]);
    const timeoutMs = auroraInteger(input.timeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS, 1000, 3_600_000, "Phase timeout");

    const startedAtMs = this.now();
    const phases: VerificationPhaseResult[] = [];
    const sandbox = await this.factory(input.workspacePath);
    let failed = false;
    try {
      for (const phase of requested) {
        const commands = input.commands?.[phase] ?? recipe[phase];
        for (const command of commands) {
          if (failed) break;
          const phaseStart = this.now();
          const result = await sandbox.exec({
            command,
            timeoutMs,
            maxOutputChars: 200_000,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          const passed = result.exitCode === 0 && !result.timedOut;
          phases.push({
            phase,
            command,
            exitCode: result.exitCode,
            durationMs: this.now() - phaseStart,
            timedOut: result.timedOut,
            // The tail is what a failure explains itself with; the head is usually build chatter.
            outputTail: result.stdout.slice(-MAX_OUTPUT_TAIL),
            passed,
          });
          if (!passed) failed = true;
        }
        if (failed) break;
      }
    } finally {
      await sandbox.destroy().catch(() => undefined);
    }

    const ranProof = phases.some((item) => item.phase === "build" || item.phase === "test");
    const verdict: VerificationRun["verdict"] = phases.length === 0 || !ranProof
      ? "inconclusive"
      : phases.every((item) => item.passed) ? "verified" : "failed";
    const reason = verdict === "verified"
      ? `${phases.length} phase(s) passed for ${recipe.name}.`
      : verdict === "failed"
        ? `${phases.find((item) => !item.passed)?.command ?? "a phase"} failed.`
        : `No build or test command is defined for ${recipe.name}; nothing was proven.`;

    const run: VerificationRun = {
      id: `verification-${randomUUID()}`,
      tenantId,
      sessionId,
      workspacePath: input.workspacePath,
      recipe,
      phases,
      verdict,
      reason,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
      durationMs: this.now() - startedAtMs,
      sequence: 0,
    };
    return await this.state.mutate((state) => {
      state.sequence += 1;
      run.sequence = state.sequence;
      state.runs.push(run);
      if (state.runs.length > MAX_RECORDS) state.runs.splice(0, state.runs.length - MAX_RECORDS);
      return structuredClone(run);
    });
  }

  async list(filter: { tenantId: string; sessionId?: string | undefined; limit?: number | undefined }): Promise<VerificationRun[]> {
    const state = await this.state.read();
    return state.runs
      .filter((run) => run.tenantId === filter.tenantId)
      .filter((run) => (filter.sessionId ? run.sessionId === filter.sessionId : true))
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, auroraInteger(filter.limit ?? 20, 1, MAX_RECORDS, "Verification limit"))
      .map((run) => structuredClone(run));
  }

  /** The evidence a session can point at right now: its most recent run, and whether it still counts. */
  async latest(tenantId: string, sessionId: string): Promise<{ run?: VerificationRun; verified: boolean; message: string }> {
    const [latest] = await this.list({ tenantId, sessionId, limit: 1 });
    if (!latest) return { verified: false, message: "This session has not run verification yet." };
    return {
      run: latest,
      verified: latest.verdict === "verified",
      message: latest.verdict === "verified"
        ? `Verified at ${latest.finishedAt}: ${latest.reason}`
        : `Not verified (${latest.verdict}): ${latest.reason}`,
    };
  }
}
