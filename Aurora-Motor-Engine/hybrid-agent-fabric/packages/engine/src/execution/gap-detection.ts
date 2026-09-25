/**
 * Gap detection — naming what is missing, before trying to build it.
 *
 * The motivating example from the specification:
 *
 *     "Analyse the visual changes in this GitHub PR."
 *
 *     browser          ✓ available
 *     git              ✓ available
 *     image generation ✓ available
 *     visual diff      ✗ MISSING
 *
 *     → GAP: missing_capability = visual_diff
 *            type = capability_gap
 *            confidence = 0.93
 *
 * "It failed" does not tell you what to build. A gap statement does.
 *
 * Detection runs in three tiers, cheapest and most reliable first:
 *
 *   1. DETERMINISTIC  a required capability is absent from the inventory
 *   2. STRUCTURAL     failure signatures and goal/inventory mismatch
 *   3. LLM            not implemented here — see `llmTier` below
 *
 * The ordering is not a style preference. A gap detector that needs a model
 * call cannot run when the model is the thing that failed, and it cannot be
 * tested deterministically.
 */

import type { FailureKind } from "./failure-taxonomy.js";

export const GAP_TYPES = [
  /** Information the agent needed and did not have. */
  "knowledge",
  /** No tool exists for the operation. */
  "tool",
  /** A tool exists; the agent cannot drive it to the required standard. */
  "skill",
  /** The interface differs from what was assumed. */
  "interface",
  /** The operation is possible but not permitted. */
  "permission",
  /** The work cannot be checked. */
  "verification",
  /** Not solvable with any capability — the request is ill-posed or impossible. */
  "fundamental",
] as const;

export type GapType = (typeof GAP_TYPES)[number];

export interface DetectedGap {
  readonly type: GapType;
  /** Machine-usable identifier for the thing that is missing, e.g. `visual_diff`. */
  readonly missing: string;
  /** Human sentence describing the gap. */
  readonly description: string;
  readonly confidence: number;
  /** Which tier produced this. Lower tiers are more trustworthy. */
  readonly tier: "deterministic" | "structural" | "llm";
  /** The concrete observations that justify the gap. */
  readonly evidence: readonly string[];
  /** True when building a capability could plausibly close this gap. */
  readonly synthesisable: boolean;
  /**
   * Examples a synthesised implementation must satisfy.
   *
   * Optional, and usually absent: the deterministic detectors work from a
   * requirement table and cannot invent test data. When absent,
   * `CapabilityAcquisition` refuses to build anything, because an
   * implementation verified against nothing is an implementation nobody
   * checked — and `knownBad` decoys are the only defence against code that
   * hard-codes the expected answers.
   *
   * A gap with no examples describes a problem, not a specification. Supplying
   * this is how a caller turns the former into the latter.
   */
  readonly testCases?:
    | {
        readonly knownGood: readonly { input: unknown; expected: unknown; note?: string }[];
        readonly knownBad: readonly { input: unknown; mustNotEqual: unknown; note?: string }[];
        readonly adversarial: readonly { input: unknown; note?: string }[];
      }
    | undefined;
}

/** What the detector knows about the current environment. */
export interface CapabilityInventory {
  /** Capability ids currently registered, e.g. `browser.screenshot`. */
  readonly capabilityIds: readonly string[];
  /** Free-text descriptions, used for keyword matching. */
  readonly descriptions?: readonly string[] | undefined;
}

/**
 * A known capability requirement.
 *
 * Maps observable phrases in a goal to the capability id that satisfies them.
 * Deliberately a small, explicit table rather than an inferred one: a wrong
 * inference here sends capability synthesis off to build the wrong thing.
 */
interface RequirementRule {
  readonly missing: string;
  readonly type: GapType;
  /** Phrases in the goal that imply this requirement. */
  readonly triggers: readonly RegExp[];
  /** Capability id substrings that would satisfy it. */
  readonly satisfiedBy: readonly string[];
  readonly description: string;
  readonly synthesisable: boolean;
  /**
   * Examples that define the requirement, carried onto the gap.
   *
   * Written by hand, per rule, and only where the behaviour can be pinned down
   * as a pure function. This is deliberately not generated: a detector that
   * invents its own test data would be marking its own homework, and the
   * `knownBad` decoy is the only thing standing between a real implementation
   * and one that hard-codes the known-good answers.
   *
   * A rule without examples still reports its gap; acquisition then refuses to
   * build anything, which is the honest outcome rather than a silent pass.
   */
  readonly testCases?: DetectedGap["testCases"];
}

const REQUIREMENTS: readonly RequirementRule[] = [
  {
    missing: "visual_diff",
    type: "tool",
    triggers: [
      /visual (change|diff|difference|regression)/i,
      /compare .*(screenshot|image|render|ui)/i,
      /(screenshot|image) (comparison|diff)/i,
      /görsel (değişiklik|fark|karşılaştır)/i,
    ],
    satisfiedBy: ["visual_diff", "image.compare", "screenshot.compare", "pixel"],
    description: "Comparing two images and reporting where they differ",
    synthesisable: true,
    // Pinned as a pure function over pixel arrays, because that is the part
    // that can actually be synthesised: the sandbox has no filesystem and no
    // network, so decoding a PNG is out of reach. Whatever loads the pixels
    // stays outside; the comparison itself is what gets built and checked.
    testCases: {
      knownGood: [
        { input: { a: [1, 2, 3], b: [1, 9, 3] }, expected: [1], note: "one differing pixel" },
        { input: { a: [5, 5], b: [5, 5] }, expected: [], note: "identical inputs differ nowhere" },
        { input: { a: [0, 1, 2, 3], b: [9, 1, 9, 3] }, expected: [0, 2], note: "two differing pixels" },
      ],
      knownBad: [
        {
          input: { a: [7, 7, 7], b: [7, 7, 7] },
          mustNotEqual: [1],
          // The decoy input appears in no known-good case. An implementation
          // that memorised those and falls back to a constant answers [1]
          // here, which identical inputs cannot produce. Measured: a memoriser
          // passes every known-good case and is caught by exactly this.
          note: "identical inputs cannot differ anywhere",
        },
      ],
      adversarial: [
        { input: { a: [], b: [] }, note: "empty images" },
        { input: { a: null, b: null }, note: "missing pixel data" },
        { input: { a: [1], b: [1, 2, 3] }, note: "mismatched lengths" },
      ],
    },
  },
  {
    missing: "ocr",
    type: "tool",
    triggers: [/\bocr\b/i, /extract text from (an? )?(image|scan|photo|pdf)/i, /read the text in/i],
    satisfiedBy: ["ocr", "vision.text", "tesseract"],
    description: "Extracting text from an image",
    synthesisable: false,
  },
  {
    missing: "audio_transcription",
    type: "tool",
    triggers: [/transcribe/i, /speech[- ]to[- ]text/i, /\bstt\b/i],
    satisfiedBy: ["transcri", "stt", "whisper", "speech"],
    description: "Turning speech audio into text",
    synthesisable: false,
  },
  {
    missing: "browser_automation",
    type: "tool",
    triggers: [/\b(click|navigate to|fill in) .*(page|site|form|button)/i, /automate the browser/i],
    satisfiedBy: ["browser", "playwright", "puppeteer", "cdp"],
    description: "Driving a real browser",
    synthesisable: false,
  },
  {
    missing: "email_access",
    type: "tool",
    triggers: [/\b(read|list|search) .*(email|inbox|mailbox)/i, /check my mail/i],
    satisfiedBy: ["email", "imap", "gmail", "outlook"],
    description: "Reading from a mailbox",
    synthesisable: false,
  },
  {
    missing: "pdf_parsing",
    type: "tool",
    triggers: [/parse .*pdf/i, /extract .*(from|of) (the )?pdf/i, /pdf (structure|tables?)/i],
    satisfiedBy: ["pdf", "document.parse"],
    description: "Parsing the structure of a PDF",
    // Downgraded from synthesisable after measuring what the sandbox allows.
    // Real PDF parsing needs binary decoding and a filesystem; neither exists
    // in the sandbox, so code written here could only ever fake it. Claiming
    // otherwise would send synthesis off to build something that cannot work.
    synthesisable: false,
  },
  {
    missing: "deployment",
    type: "permission",
    triggers: [/deploy to production/i, /release to prod/i],
    satisfiedBy: ["deploy"],
    description: "Deploying to a production environment",
    synthesisable: false,
  },
];

/**
 * Tier 1 — deterministic.
 *
 * A requirement is triggered by the goal and nothing in the inventory
 * satisfies it. This is the highest-confidence signal available: it rests on
 * an inventory lookup, not a judgement.
 */
export function detectDeterministicGaps(
  goal: string,
  inventory: CapabilityInventory,
): readonly DetectedGap[] {
  const haystack = [...inventory.capabilityIds, ...(inventory.descriptions ?? [])]
    .join(" ")
    .toLowerCase();

  const gaps: DetectedGap[] = [];

  for (const rule of REQUIREMENTS) {
    const trigger = rule.triggers.find((pattern) => pattern.test(goal));
    if (!trigger) continue;

    const satisfied = rule.satisfiedBy.some((token) => haystack.includes(token.toLowerCase()));
    if (satisfied) continue;

    gaps.push({
      type: rule.type,
      missing: rule.missing,
      description: rule.description,
      // High but not certain: the goal genuinely implies the requirement and
      // the inventory genuinely lacks it. The residual doubt is whether the
      // phrasing was meant literally.
      confidence: 0.93,
      tier: "deterministic",
      evidence: [
        `Goal matches /${trigger.source}/`,
        `No registered capability matches any of: ${rule.satisfiedBy.join(", ")}`,
        `Inventory holds ${inventory.capabilityIds.length} capabilities`,
      ],
      synthesisable: rule.synthesisable,
      // Carried through so acquisition has a specification, not just a name.
      // Absent for most rules, and acquisition stops honestly when it is.
      ...(rule.testCases ? { testCases: rule.testCases } : {}),
    });
  }

  return gaps;
}

/**
 * Tier 2 — structural.
 *
 * Derives a gap from how the task failed. Weaker than tier 1 because it
 * infers the missing thing from an error message rather than looking it up.
 */
export function detectStructuralGaps(
  failureKind: FailureKind,
  failureMessage: string,
): readonly DetectedGap[] {
  const named = extractMissingName(failureMessage);

  const mapping: Partial<Record<FailureKind, { type: GapType; synthesisable: boolean; description: string }>> = {
    tool_gap: { type: "tool", synthesisable: true, description: "No tool exists for the requested operation" },
    skill_gap: { type: "skill", synthesisable: false, description: "The tool exists but the approach is not working" },
    knowledge_gap: { type: "knowledge", synthesisable: false, description: "Required information was not available" },
    interface_gap: { type: "interface", synthesisable: true, description: "The interface did not match expectations" },
    permission_gap: { type: "permission", synthesisable: false, description: "The operation is not permitted" },
    verification_gap: { type: "verification", synthesisable: true, description: "The result cannot be checked" },
    fundamental_unknown: { type: "fundamental", synthesisable: false, description: "The failure could not be attributed" },
  };

  const entry = mapping[failureKind];
  if (!entry) return [];

  return [
    {
      type: entry.type,
      missing: named ?? failureKind,
      description: entry.description,
      // Deliberately below the deterministic tier. An error string is weaker
      // evidence than an inventory lookup.
      confidence: named ? 0.7 : 0.5,
      tier: "structural",
      evidence: [
        `Failure classified as ${failureKind}`,
        named ? `Extracted missing name: ${named}` : "No specific name could be extracted from the failure",
        `Message: ${failureMessage.slice(0, 200)}`,
      ],
      synthesisable: entry.synthesisable,
    },
  ];
}

/**
 * Pull a quoted or obvious identifier out of an error message.
 *
 * `no such tool 'visual_diff'` → `visual_diff`
 */
function extractMissingName(message: string): string | undefined {
  const patterns = [
    /no such tool ['"`]([\w.\-]+)['"`]/i,
    /unknown (?:tool|capability|command) ['"`]([\w.\-]+)['"`]/i,
    /capability ['"`]([\w.\-]+)['"`] (?:is )?(?:not|missing|unavailable)/i,
    /['"`]([\w.\-]+)['"`] is not implemented/i,
    /tool ['"`]([\w.\-]+)['"`]/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export interface GapReport {
  readonly gaps: readonly DetectedGap[];
  /** Highest-confidence gap that could be closed by building something. */
  readonly actionable: DetectedGap | undefined;
  readonly summary: string;
}

/**
 * Run the tiers and merge their findings.
 *
 * Deduplicates by `missing`, keeping the strongest tier — a deterministic
 * finding supersedes a structural guess about the same thing.
 */
export function detectGaps(input: {
  goal: string;
  inventory: CapabilityInventory;
  failureKind?: FailureKind | undefined;
  failureMessage?: string | undefined;
}): GapReport {
  const found: DetectedGap[] = [...detectDeterministicGaps(input.goal, input.inventory)];

  if (input.failureKind && input.failureMessage) {
    found.push(...detectStructuralGaps(input.failureKind, input.failureMessage));
  }

  const byName = new Map<string, DetectedGap>();
  for (const gap of found) {
    const existing = byName.get(gap.missing);
    if (!existing || rank(gap) > rank(existing)) byName.set(gap.missing, gap);
  }

  const gaps = [...byName.values()].sort((a, b) => rank(b) - rank(a));
  const actionable = gaps.find((gap) => gap.synthesisable);

  return {
    gaps,
    actionable,
    summary:
      gaps.length === 0
        ? "No capability gap detected."
        : `${gaps.length} gap(s): ${gaps.map((gap) => `${gap.missing} (${gap.type}, ${gap.confidence.toFixed(2)})`).join("; ")}`,
  };
}

function rank(gap: DetectedGap): number {
  const tierWeight = gap.tier === "deterministic" ? 100 : gap.tier === "structural" ? 50 : 10;
  return tierWeight + gap.confidence * 10;
}

/**
 * Tier 3 — LLM-assisted detection.
 *
 * NOT IMPLEMENTED, and it throws rather than returning an empty list.
 *
 * Returning `[]` would be indistinguishable from "the model looked and found
 * nothing", which is the fabricated-success pattern this codebase has already
 * been burned by. A caller that wants this tier must supply a model and
 * implement it.
 */
export function llmTier(): never {
  throw new Error(
    "LLM-assisted gap detection is not implemented. It requires a model binding. " +
      "Deterministic and structural tiers run without one; use those, or supply an implementation.",
  );
}
