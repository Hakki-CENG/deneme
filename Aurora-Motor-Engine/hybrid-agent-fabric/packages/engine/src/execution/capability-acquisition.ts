/**
 * Capability acquisition — closing a detected gap, with proof.
 *
 * Gap detection names what is missing. This turns that name into a working,
 * verified capability, or fails honestly. It is the provider that
 * `UnifiedExecutionLoop.acquireCapability` expects.
 *
 * The pipeline (specification item 12):
 *
 *     Gap
 *      → Capability Contract      what it must accept and return
 *      → Implementation           supplied by a generator, never invented here
 *      → Static Analysis          reject dangerous constructs before running
 *      → Sandbox                  real Worker isolate
 *      → Known-good checks        it must produce the right answers
 *      → Known-bad decoys         it must NOT pass these
 *      → Adversarial tests        it must survive hostile input
 *      → Quarantine → Verification → Promotion
 *
 * Two rules carry most of the weight:
 *
 *   1. **Known-bad decoys.** A capability that passes every known-good case may
 *      still be a cheat — `return true`, or a lookup table of the test inputs.
 *      Decoys are inputs where the *correct* behaviour is to fail or to return
 *      something different. An implementation that "passes" a decoy has been
 *      caught pattern-matching the tests rather than doing the work. Without
 *      this, capability synthesis is a reward-hacking machine.
 *
 *   2. **Generated code never enters the core process** (item 14). Everything
 *      runs in the sandbox's separate isolate. There is no dynamic import here,
 *      and there must not be one.
 */

import { randomUUID } from "node:crypto";

import type {
  CapabilitySynthesisPipeline,
  SandboxExecutionResult,
} from "../capabilities/capability-synthesis.js";
import type { DetectedGap } from "./gap-detection.js";

/** Lifecycle of an acquired capability (specification item 15). */
export const CAPABILITY_LIFECYCLE = [
  "draft",
  "candidate",
  "quarantined",
  "verified",
  "promoted",
  "deprecated",
  "revoked",
] as const;

export type CapabilityLifecycleState = (typeof CAPABILITY_LIFECYCLE)[number];

/**
 * What a capability must satisfy before anything may use it
 * (specification item 13).
 */
export interface CapabilityContract {
  readonly name: string;
  readonly description: string;
  /** Plain description of the accepted input. */
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly permissions: readonly string[];
  readonly sideEffects: boolean;
  readonly dependencies: readonly string[];
  readonly risk: "low" | "medium" | "high" | "critical";
  readonly version: string;
  /** Where this came from: the gap that motivated it. */
  readonly origin: string;

  /** Inputs with known-correct outputs. The capability MUST match these. */
  readonly knownGood: readonly { input: unknown; expected: unknown; note?: string }[];

  /**
   * Inputs where a correct implementation must NOT return `expectedWrong`.
   *
   * These catch an implementation that hard-codes the known-good answers or
   * returns a constant. If a decoy "passes", the capability is cheating.
   */
  readonly knownBad: readonly { input: unknown; mustNotEqual: unknown; note?: string }[];

  /** Hostile inputs it must survive without crashing. */
  readonly adversarial: readonly { input: unknown; note?: string }[];
}

export interface AcquisitionStep {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface AcquisitionResult {
  readonly acquired: boolean;
  readonly capabilityId: string | undefined;
  readonly state: CapabilityLifecycleState;
  readonly contract: CapabilityContract;
  readonly steps: readonly AcquisitionStep[];
  readonly summary: string;
}

/**
 * Produces an implementation for a contract.
 *
 * Supplied by the caller — usually a model. This module never writes the
 * implementation itself, because a hand-rolled fallback would mean the system
 * reports "capability acquired" for code nobody generated.
 */
export type ImplementationGenerator = (
  contract: CapabilityContract,
  gap: DetectedGap,
) => Promise<string>;

/**
 * Patterns that must not appear in generated code.
 *
 * The sandbox already blocks these at runtime; rejecting them first means a
 * hostile or careless implementation never gets executed at all, and the
 * failure names the reason instead of surfacing an opaque sandbox error.
 */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brequire\s*\(/, reason: "requires a module" },
  { pattern: /\bimport\s*\(/, reason: "uses dynamic import" },
  { pattern: /\bprocess\b/, reason: "touches process" },
  { pattern: /\beval\s*\(/, reason: "calls eval" },
  { pattern: /new\s+Function\s*\(/, reason: "constructs a function from a string" },
  { pattern: /\bglobalThis\b/, reason: "reaches for globalThis" },
  { pattern: /\bWorker\b/, reason: "spawns a worker" },
  { pattern: /\b__proto__\b/, reason: "manipulates the prototype chain" },
  { pattern: /\bconstructor\s*\[/, reason: "reaches the constructor by index" },
  { pattern: /\bfetch\s*\(/, reason: "performs network I/O" },
];

export function analyseStatically(code: string): { safe: boolean; findings: readonly string[] } {
  const findings: string[] = [];

  if (!code.trim()) findings.push("implementation is empty");

  for (const { pattern, reason } of FORBIDDEN) {
    if (pattern.test(code)) findings.push(`${reason} (/${pattern.source}/)`);
  }

  return { safe: findings.length === 0, findings };
}

/** Build a contract from a detected gap. */
export function contractFromGap(gap: DetectedGap, overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name: gap.missing,
    description: gap.description,
    inputSchema: "unknown",
    outputSchema: "unknown",
    permissions: [],
    sideEffects: false,
    dependencies: [],
    risk: gap.type === "permission" ? "high" : "medium",
    version: "0.1.0",
    origin: `gap:${gap.type}:${gap.missing}`,
    knownGood: [],
    knownBad: [],
    adversarial: [],
    ...overrides,
  };
}

export interface AcquisitionOptions {
  readonly timeoutMs?: number | undefined;
  /**
   * Minimum known-good cases required.
   *
   * Default 2. A contract with no known-good cases cannot be verified, and
   * accepting it would mean promoting an unchecked implementation.
   */
  readonly minKnownGood?: number | undefined;
  /**
   * Minimum known-bad decoys required.
   *
   * Default 1. Without a decoy there is no defence against an implementation
   * that hard-codes the expected answers.
   */
  readonly minKnownBad?: number | undefined;
}

/**
 * Runs the acquisition pipeline for one gap.
 */
export class CapabilityAcquisition {
  constructor(
    private readonly pipeline: CapabilitySynthesisPipeline,
    private readonly generate: ImplementationGenerator,
    private readonly options: AcquisitionOptions = {},
  ) {
    if (typeof generate !== "function") {
      throw new Error(
        "CapabilityAcquisition requires an implementation generator. " +
          "Without one it would report capabilities it never built.",
      );
    }
  }

  async acquire(gap: DetectedGap, contract: CapabilityContract): Promise<AcquisitionResult> {
    const steps: AcquisitionStep[] = [];
    const minKnownGood = this.options.minKnownGood ?? 2;
    const minKnownBad = this.options.minKnownBad ?? 1;

    const fail = (state: CapabilityLifecycleState, summary: string, capabilityId?: string): AcquisitionResult => ({
      acquired: false,
      capabilityId,
      state,
      contract,
      steps,
      summary,
    });

    // ── Contract adequacy ────────────────────────────────────────────────
    if (!gap.synthesisable) {
      steps.push({
        name: "contract",
        passed: false,
        detail: `Gap '${gap.missing}' is not synthesisable: ${gap.description}. Writing code cannot supply it.`,
      });
      return fail("draft", `Cannot synthesise '${gap.missing}' — it needs an external backend, not an implementation.`);
    }

    if (contract.knownGood.length < minKnownGood) {
      steps.push({
        name: "contract",
        passed: false,
        detail: `Only ${contract.knownGood.length} known-good case(s); ${minKnownGood} required.`,
      });
      return fail(
        "draft",
        `Contract for '${contract.name}' cannot be verified: too few known-good cases. ` +
          `Accepting it would promote an unchecked implementation.`,
      );
    }

    if (contract.knownBad.length < minKnownBad) {
      steps.push({
        name: "contract",
        passed: false,
        detail: `No known-bad decoys supplied; ${minKnownBad} required.`,
      });
      return fail(
        "draft",
        `Contract for '${contract.name}' has no decoys. Without them an implementation that hard-codes ` +
          `the expected answers would pass every check.`,
      );
    }

    steps.push({
      name: "contract",
      passed: true,
      detail:
        `${contract.knownGood.length} known-good, ${contract.knownBad.length} decoy(s), ` +
        `${contract.adversarial.length} adversarial case(s).`,
    });

    // ── Implementation ───────────────────────────────────────────────────
    let code: string;
    try {
      code = await this.generate(contract, gap);
    } catch (error) {
      steps.push({
        name: "implementation",
        passed: false,
        detail: `Generator threw: ${message(error)}`,
      });
      return fail("draft", `No implementation was produced for '${contract.name}'.`);
    }

    steps.push({ name: "implementation", passed: true, detail: `${code.length} characters generated.` });

    // ── Static analysis ──────────────────────────────────────────────────
    const analysis = analyseStatically(code);
    steps.push({
      name: "static-analysis",
      passed: analysis.safe,
      detail: analysis.safe ? "No forbidden constructs." : analysis.findings.join("; "),
    });
    if (!analysis.safe) {
      return fail("draft", `Implementation for '${contract.name}' was rejected before execution: ${analysis.findings.join("; ")}`);
    }

    // ── Sandbox: first known-good case creates and quarantines it ────────
    const first = contract.knownGood[0]!;
    let synthesised: Awaited<ReturnType<CapabilitySynthesisPipeline["synthesizeAndTest"]>>;
    try {
      synthesised = await this.pipeline.synthesizeAndTest({
        name: `${contract.name}-${randomUUID().slice(0, 8)}`,
        description: contract.description,
        code,
        testInput: first.input,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (error) {
      steps.push({ name: "sandbox", passed: false, detail: `Sandbox refused to run it: ${message(error)}` });
      return fail("draft", `'${contract.name}' could not be executed in the sandbox.`);
    }

    const capabilityId = synthesised.capability.id;

    if (!synthesised.executionResult.success) {
      steps.push({
        name: "sandbox",
        passed: false,
        detail: `First known-good case failed: ${synthesised.executionResult.error ?? "unknown error"}`,
      });
      return fail("quarantined", `'${contract.name}' failed in the sandbox and stays quarantined.`, capabilityId);
    }

    steps.push({
      name: "sandbox",
      passed: true,
      detail: `Executed in ${synthesised.executionResult.durationMs}ms.`,
    });

    // ── Known-good checks ────────────────────────────────────────────────
    const goodFailures: string[] = [];
    for (const [index, sample] of contract.knownGood.entries()) {
      const result = await this.runCase(capabilityId, sample.input);
      if (!result.success) {
        goodFailures.push(`case ${index}: errored (${result.error ?? "unknown"})`);
        continue;
      }
      if (!deepEqual(result.output, sample.expected)) {
        goodFailures.push(
          `case ${index}: expected ${preview(sample.expected)}, got ${preview(result.output)}`,
        );
      }
    }

    steps.push({
      name: "known-good",
      passed: goodFailures.length === 0,
      detail:
        goodFailures.length === 0
          ? `All ${contract.knownGood.length} cases produced the expected output.`
          : goodFailures.join("; "),
    });
    if (goodFailures.length > 0) {
      return fail("quarantined", `'${contract.name}' does not do what the contract requires.`, capabilityId);
    }

    // ── Known-bad decoys ─────────────────────────────────────────────────
    // A decoy that "passes" means the implementation returned the value it was
    // supposed to be unable to produce — the signature of hard-coded answers.
    const cheats: string[] = [];
    for (const [index, decoy] of contract.knownBad.entries()) {
      const result = await this.runCase(capabilityId, decoy.input);
      // An error here is acceptable: refusing a decoy is correct behaviour.
      if (result.success && deepEqual(result.output, decoy.mustNotEqual)) {
        cheats.push(
          `decoy ${index}: returned ${preview(decoy.mustNotEqual)}, which a genuine implementation could not produce` +
            (decoy.note ? ` (${decoy.note})` : ""),
        );
      }
    }

    steps.push({
      name: "known-bad-decoys",
      passed: cheats.length === 0,
      detail:
        cheats.length === 0
          ? `Survived ${contract.knownBad.length} decoy(s) without cheating.`
          : cheats.join("; "),
    });
    if (cheats.length > 0) {
      return fail(
        "quarantined",
        `'${contract.name}' appears to pattern-match its tests rather than implement the behaviour.`,
        capabilityId,
      );
    }

    // ── Adversarial ──────────────────────────────────────────────────────
    const crashes: string[] = [];
    for (const [index, hostile] of contract.adversarial.entries()) {
      const result = await this.runCase(capabilityId, hostile.input);
      // Returning an error is fine. Hanging or crashing the sandbox is not, and
      // the sandbox reports that as a failure with a timeout/termination error.
      if (!result.success && /timeout|terminated|out of memory/i.test(result.error ?? "")) {
        crashes.push(`adversarial ${index}: ${result.error}`);
      }
    }

    steps.push({
      name: "adversarial",
      passed: crashes.length === 0,
      detail:
        contract.adversarial.length === 0
          ? "No adversarial cases were supplied."
          : crashes.length === 0
            ? `Survived ${contract.adversarial.length} hostile input(s).`
            : crashes.join("; "),
    });
    if (crashes.length > 0) {
      return fail("quarantined", `'${contract.name}' can be crashed by hostile input.`, capabilityId);
    }

    // ── Verified ─────────────────────────────────────────────────────────
    // Note the capability stays in the synthesis registry and the sandbox. It
    // is NOT imported into this process (specification item 14).
    steps.push({
      name: "verification",
      passed: true,
      detail: "Contract satisfied, decoys rejected, hostile input survived.",
    });

    return {
      acquired: true,
      capabilityId,
      state: "verified",
      contract,
      steps,
      summary:
        `Acquired '${contract.name}': ${contract.knownGood.length} known-good passed, ` +
        `${contract.knownBad.length} decoy(s) rejected, ${contract.adversarial.length} adversarial survived.`,
    };
  }

  private async runCase(capabilityId: string, input: unknown): Promise<SandboxExecutionResult> {
    try {
      return await this.pipeline.testInSandbox(capabilityId, input);
    } catch (error) {
      return {
        id: randomUUID(),
        capabilityId,
        success: false,
        error: message(error),
        durationMs: 0,
        executedAt: new Date().toISOString(),
        sandboxId: "none",
      };
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch {
    return String(value);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
}
