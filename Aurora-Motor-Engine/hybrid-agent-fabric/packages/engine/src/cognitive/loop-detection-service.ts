/**
 * Loop Detection Engine (master: "Aurora'nın aynı şeyi tekrar tekrar
 * düşünmesini engeller — aynı sonuç N kez üretildi, durdur").
 *
 * What this measures, stated plainly: the SAME outcome signature recurring
 * across tasks or thoughts. The execution loop already caps retries inside
 * one task (attempts, replans, prior-failure briefings); what did not exist
 * was the cross-task signal — the third identical failure this week is a
 * loop, not three unrelated failures.
 *
 * What this service does NOT do: it never blocks a caller's explicit
 * request. "Durdur" is implemented as a measured, durable, queryable signal
 * (plus an auto-derived specialist proposal and a risk initiative through
 * the services that consume this one), because refusing a task the user
 * explicitly asked for would be a different feature than the one the master
 * describes — and an unsafe one.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

export type LoopSubjectKind = "task" | "thought";

export interface LoopOccurrence {
  at: string;
  subject: string;
  summary: string;
  /** Capability ids measured on this occurrence; feeds specialist proposals. */
  capabilities: string[];
  /** Optional correlation ref (task id, thought id). */
  ref?: string;
}

export interface DetectedLoop {
  id: string;
  tenantId: string;
  kind: LoopSubjectKind;
  /** Stable digest of the recurring outcome (goal + status + failure kinds). */
  signature: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  status: "active" | "acknowledged";
  /** Last occurrences, capped so a long-running loop cannot grow unbounded. */
  evidence: LoopOccurrence[];
  /** When the recurrence first crossed the threshold; "" before that. */
  detectedAt: string;
}

interface LoopState {
  schemaVersion: 1;
  loops: DetectedLoop[];
}

export interface LoopRecordResult {
  occurrences: number;
  threshold: number;
  /** True only on the record that crossed the threshold, not on every later one. */
  thresholdReached: boolean;
  loop: DetectedLoop | undefined;
}

const MAX_EVIDENCE = 10;

export class LoopDetectionService {
  private readonly store: DurableJsonState<LoopState>;
  private readonly threshold: number;

  constructor(
    rootPath: string,
    private readonly now: () => number = Date.now,
    threshold = 3,
  ) {
    if (!Number.isInteger(threshold) || threshold < 2) {
      throw new Error("Loop detection threshold must be an integer >= 2.");
    }
    this.threshold = threshold;
    this.store = new DurableJsonState<LoopState>(
      join(rootPath, "loop-detection.json"),
      () => ({ schemaVersion: 1, loops: [] }),
      (value) => {
        const state = value as LoopState;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.loops);
      },
      "Aurora loop detection",
    );
  }

  async init(): Promise<void> {
    await this.store.read();
  }

  /**
   * Records one outcome occurrence. The loop this returns (when the
   * threshold is crossed) is a clone; acknowledging works by id.
   */
  async record(input: {
    tenantId: string;
    kind: LoopSubjectKind;
    signature: string;
    subject: string;
    summary: string;
    capabilities?: readonly string[];
    ref?: string;
  }): Promise<LoopRecordResult> {
    const at = new Date(this.now()).toISOString();
    const occurrence: LoopOccurrence = {
      at,
      subject: input.subject.slice(0, 200),
      summary: input.summary.slice(0, 500),
      capabilities: [...new Set(input.capabilities ?? [])],
      ...(input.ref ? { ref: input.ref } : {}),
    };

    return await this.store.mutate((state) => {
      // Only an ACTIVE loop accumulates: an acknowledged loop stays in the
      // record as history, and the same signature starting again after the
      // acknowledgement counts from zero — that is what acknowledging means.
      let loop = state.loops.find(
        (item) =>
          item.tenantId === input.tenantId &&
          item.kind === input.kind &&
          item.signature === input.signature &&
          item.status === "active",
      );
      let thresholdReached = false;
      if (!loop) {
        loop = {
          id: `loop-${randomUUID()}`,
          tenantId: input.tenantId,
          kind: input.kind,
          signature: input.signature,
          occurrences: 0,
          firstSeenAt: at,
          lastSeenAt: at,
          status: "active",
          evidence: [],
          detectedAt: "",
        };
        state.loops.push(loop);
      }
      loop.occurrences += 1;
      loop.lastSeenAt = at;
      loop.evidence.push(occurrence);
      if (loop.evidence.length > MAX_EVIDENCE) {
        loop.evidence = loop.evidence.slice(loop.evidence.length - MAX_EVIDENCE);
      }
      if (loop.occurrences >= this.threshold && loop.detectedAt === "") {
        loop.detectedAt = at;
        thresholdReached = true;
      }
      return {
        occurrences: loop.occurrences,
        threshold: this.threshold,
        thresholdReached,
        loop: thresholdReached ? structuredClone(loop) : undefined,
      };
    });
  }

  async loops(tenantId: string, status?: DetectedLoop["status"]): Promise<DetectedLoop[]> {
    const state = await this.store.read();
    return state.loops
      .filter((item) => item.tenantId === tenantId && (!status || item.status === status))
      .map((item) => structuredClone(item));
  }

  /**
   * Loops that actually crossed the threshold. A below-threshold entry is
   * recurrence counting, not a loop: calling it one would flag every task
   * that has ever failed once.
   */
  async activeLoops(tenantId: string): Promise<DetectedLoop[]> {
    const state = await this.store.read();
    return state.loops
      .filter((item) => item.tenantId === tenantId && item.status === "active" && item.detectedAt !== "")
      .map((item) => structuredClone(item));
  }

  /** Marks a loop acknowledged: history stays, the count starts anew. */
  async acknowledge(tenantId: string, loopId: string): Promise<DetectedLoop> {
    return await this.store.mutate((state) => {
      const loop = state.loops.find(
        (item) => item.tenantId === tenantId && item.id === loopId,
      );
      if (!loop) throw new Error(`Loop ${loopId} not found for this tenant.`);
      loop.status = "acknowledged";
      return structuredClone(loop);
    });
  }
}
