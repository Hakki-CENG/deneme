/**
 * D6 (P1.18: contradiction management): adjudicate detected contradictions.
 *
 * What was measured before this existed. The graph already had the two ends of
 * the chain and nothing between them:
 *
 *  - `detectContradictions(tenantId)` — active claims that share subject matter
 *    but assert opposite polarity, wired into `contradicts` relations and
 *    mutual `contradictionIds`;
 *  - `supersede(tenantId, id, replacementId)` — marks the loser superseded,
 *    retained for provenance, excluded from recall by the `active` filter.
 *
 * Between them: nothing. A detected contradiction sat there forever with both
 * sides active, both sides recalled into every prompt, and the only way it ever
 * resolved was a caller hand-picking ids — which no caller did, because none
 * was in a position to judge. The "compare evidence → confidence → supersede"
 * half of the roadmap item (master P1.18: "Source, provenance, confidence …
 * superseded state. User correction/retraction. Contradiction management.")
 * did not exist.
 *
 * The policy here is deliberately in code, not in a model: an adjudicator a
 * model can talk its way around is not an adjudicator. Three rules, in order:
 *
 *  1. A user-sourced side against a non-user side wins outright — the master
 *     plan's "user correction/retraction": when a human corrects the record,
 *     the correction beats the machine's earlier belief, whatever its
 *     confidence said.
 *  2. Otherwise, evidence strength decides — source weight (who is speaking),
 *     claim weight (how direct the observation is), stated confidence, and
 *     corroborating evidence refs. A gap of at least `threshold` supersedes.
 *  3. Anything closer than the threshold stays a contradiction: both sides
 *     active, both flagged, nobody promoted. Recency does NOT break ties —
 *     "the newest claim wins" is "the agent's last word is true", which is the
 *     exact assumption the verification layer exists to reject.
 */
import type { MemoryGraphService, MemoryObjectRecord } from "./memory-graph-service.js";

/** How directly each kind of speaker can know the thing it asserts. */
const SOURCE_WEIGHT: Record<MemoryObjectRecord["sourceType"], number> = {
  // A human corrected the record. P1.18 gives this the final word.
  user: 1.0,
  // A measured event the system itself witnessed.
  event: 0.85,
  // Derived by system rules from other state.
  system: 0.7,
  // An agent's conclusion — one step from the evidence.
  agent: 0.6,
  // Recalled from an earlier memory: the weakest kind of witness.
  memory: 0.5,
  // Outside the system, unverified provenance.
  external: 0.45,
};

/** How direct each kind of claim is. */
const CLAIM_WEIGHT: Record<MemoryObjectRecord["claimType"], number> = {
  // Was directly observed.
  observation: 1.0,
  // Inferred from observations.
  inference: 0.8,
  // A forward-looking statement.
  prediction: 0.6,
  // Explicitly tentative.
  hypothesis: 0.5,
};

/** Corroborating evidence helps, with diminishing returns past a handful. */
function evidenceBonus(count: number): number {
  return Math.min(count, 5) * 0.05;
}

/** The evidence strength of one side of a contradiction (pure). */
export function evidenceStrength(side: {
  sourceType: MemoryObjectRecord["sourceType"];
  claimType: MemoryObjectRecord["claimType"];
  confidence: number;
  evidenceRefs: readonly string[];
}): number {
  return (
    SOURCE_WEIGHT[side.sourceType] *
    CLAIM_WEIGHT[side.claimType] *
    side.confidence +
    evidenceBonus(side.evidenceRefs.length)
  );
}

export interface ContradictionVerdict {
  readonly resolution: "supersede" | "unresolved";
  readonly winnerId?: string | undefined;
  readonly loserId?: string | undefined;
  readonly leftStrength: number;
  readonly rightStrength: number;
  readonly reason: string;
}

export interface AdjudicateOptions {
  /** Minimum strength gap before a side is promoted; below it, nobody is. */
  readonly threshold?: number | undefined;
}

/**
 * Decide one detected contradiction (pure).
 *
 * `left` is the earlier memory and `right` the later one, but recency is
 * deliberately not an input to the decision: order of arrival is not evidence.
 */
export function adjudicate(
  left: MemoryObjectRecord,
  right: MemoryObjectRecord,
  options: AdjudicateOptions = {},
): ContradictionVerdict {
  const threshold = options.threshold ?? 0.25;
  const leftStrength = evidenceStrength(left);
  const rightStrength = evidenceStrength(right);

  // Rule 1: a user correction beats a machine belief, without a margin
  // requirement. The margin exists to protect a confident lie from a weak
  // truth; a user correction is not that situation.
  const leftIsUser = left.sourceType === "user";
  const rightIsUser = right.sourceType === "user";
  if (leftIsUser !== rightIsUser) {
    const winner = leftIsUser ? left : right;
    const loser = leftIsUser ? right : left;
    return {
      resolution: "supersede",
      winnerId: winner.id,
      loserId: loser.id,
      leftStrength,
      rightStrength,
      reason:
        "a user-sourced claim supersedes a machine-sourced one (user correction, P1.18)",
    };
  }

  // Rule 2: a clear evidence gap decides.
  if (Math.abs(leftStrength - rightStrength) >= threshold) {
    const winner = leftStrength > rightStrength ? left : right;
    const loser = leftStrength > rightStrength ? right : left;
    return {
      resolution: "supersede",
      winnerId: winner.id,
      loserId: loser.id,
      leftStrength,
      rightStrength,
      reason:
        `evidence strength ${Math.max(leftStrength, rightStrength).toFixed(3)} vs ` +
        `${Math.min(leftStrength, rightStrength).toFixed(3)} exceeds the ${threshold} margin`,
    };
  }

  // Rule 3: too close to call. Both stay active and flagged; the health
  // report already surfaces active contradictions, which is where a human
  // (or a later, better-evidenced memory) picks this up.
  return {
    resolution: "unresolved",
    leftStrength,
    rightStrength,
    reason:
      `evidence strength ${leftStrength.toFixed(3)} vs ${rightStrength.toFixed(3)} is inside ` +
      `the ${threshold} margin, so both claims stay active and flagged`,
  };
}

/** The outcome of adjudicating one pair, including what was applied. */
export interface ContradictionResolution extends ContradictionVerdict {
  readonly applied: boolean;
}

/**
 * The contradiction engine: run detection's output through adjudication and
 * apply what the verdicts justify.
 *
 * Built on the graph's own primitives — `detectContradictions` finds,
 * `adjudicate` decides, `supersede` applies — so the durable record keeps one
 * shape and this service adds exactly the missing middle.
 */
export class MemoryContradictionService {
  constructor(private readonly graph: MemoryGraphService) {}

  /**
   * Adjudicate one known contradiction pair and apply the verdict.
   *
   * The relation is assumed to exist (detection or a human drew it); this
   * decides it. Unknown or cross-tenant ids are an error, not a silent skip:
   * a caller who names a pair deserves to hear that the pair is not there.
   */
  async resolvePair(
    tenantId: string,
    leftId: string,
    rightId: string,
    options?: AdjudicateOptions | undefined,
  ): Promise<ContradictionResolution> {
    // The graph's `get` throws when either id is unknown or cross-tenant,
    // which is exactly the caller-deserved failure here.
    const [left, right] = await Promise.all([
      this.graph.get(tenantId, leftId),
      this.graph.get(tenantId, rightId),
    ]);

    const verdict = adjudicate(left, right, options);
    if (verdict.resolution === "unresolved") {
      return { ...verdict, applied: false };
    }

    await this.graph.supersede(tenantId, verdict.loserId!, verdict.winnerId!);
    return { ...verdict, applied: true };
  }

  /**
   * Detect contradictions for a tenant and adjudicate every one of them.
   *
   * Idempotent by construction: detection only considers ACTIVE claims, and a
   * superseded memory stops being active, so a second run re-examines only
   * what genuinely remains contested.
   */
  async resolveDetected(
    tenantId: string,
    options?: { similarityThreshold?: number | undefined; threshold?: number | undefined },
  ): Promise<{
    detected: number;
    resolved: number;
    resolutions: readonly ContradictionResolution[];
  }> {
    const pairs = await this.graph.detectContradictions(tenantId, {
      ...(options?.similarityThreshold !== undefined
        ? { similarityThreshold: options.similarityThreshold }
        : {}),
    });

    const resolutions: ContradictionResolution[] = [];
    for (const pair of pairs) {
      resolutions.push(
        await this.resolvePair(tenantId, pair.leftId, pair.rightId, {
          ...(options?.threshold !== undefined ? { threshold: options.threshold } : {}),
        }),
      );
    }

    return {
      detected: pairs.length,
      resolved: resolutions.filter((item) => item.applied).length,
      resolutions,
    };
  }
}
