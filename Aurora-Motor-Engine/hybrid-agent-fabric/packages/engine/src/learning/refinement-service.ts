import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "../types.js";
import type { EventStore } from "../persistence/event-store.js";
import { atomicWrite } from "../util/atomic-file.js";
import type { LearningCandidate, LearningGovernor, LearningKind, LearningScope } from "./learning-governor.js";

export interface RefinementEditInput {
  kind: LearningKind;
  title: string;
  content: string;
  expectedOutcome: string;
  payload?: Record<string, JsonValue>;
  risk?: "low" | "medium" | "high";
}

export interface RefinementBatch {
  id: string;
  tenantId: string;
  sessionId: string;
  scope: LearningScope;
  trigger: string;
  rationale: string;
  evidenceEventIds: string[];
  candidateIds: string[];
  status: "proposed" | "partially_rejected" | "promoted" | "partially_promoted" | "rolled_back";
  createdBy: "agent" | "user" | "system";
  createdAt: string;
  updatedAt: string;
  rollbackAt?: string;
}

export class RefinementService {
  private batches: RefinementBatch[] = [];
  private loaded = false;

  constructor(
    private readonly rootPath: string,
    private readonly governor: LearningGovernor,
    private readonly events?: EventStore,
  ) {}

  private get path(): string { return join(this.rootPath, "learning", "refinements.json"); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.batches = Array.isArray(parsed) ? parsed as RefinementBatch[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.batches, null, 2)}\n`);
  }

  async create(input: {
    tenantId: string;
    sessionId: string;
    scope?: LearningScope;
    trigger: string;
    rationale: string;
    evidenceEventIds: string[];
    edits: RefinementEditInput[];
    createdBy: "agent" | "user" | "system";
  }): Promise<{ batch: RefinementBatch; candidates: LearningCandidate[] }> {
    await this.load();
    if (!input.trigger.trim() || !input.rationale.trim()) throw new Error("Refinement trigger and rationale are required.");
    if (input.edits.length < 1 || input.edits.length > 8) throw new Error("A refinement batch requires 1 to 8 small edits.");
    if (input.createdBy === "agent" && input.evidenceEventIds.length === 0) throw new Error("Agent refinement requires evidence event IDs.");
    if (this.events && input.evidenceEventIds.length > 0) {
      const actual = new Set((await this.events.read(input.sessionId, 0, 100_000)).map((event) => event.eventId));
      const missing = [...new Set(input.evidenceEventIds)].filter((eventId) => !actual.has(eventId));
      if (missing.length) throw new Error(`Refinement evidence does not belong to the session event log: ${missing.slice(0, 5).join(", ")}`);
    }
    const scope = input.scope ?? "session";
    const candidates: LearningCandidate[] = [];
    for (const edit of input.edits) {
      candidates.push(await this.governor.propose({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        kind: edit.kind,
        scope,
        title: edit.title,
        content: edit.content,
        payload: { ...(edit.payload ?? {}), refinementTrigger: input.trigger, refinementRationale: input.rationale },
        evidenceEventIds: input.evidenceEventIds,
        expectedOutcome: edit.expectedOutcome,
        ...(edit.risk ? { risk: edit.risk } : {}),
        createdBy: input.createdBy,
      }));
    }
    const now = new Date().toISOString();
    const batch: RefinementBatch = {
      id: randomUUID(),
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      scope,
      trigger: input.trigger.trim(),
      rationale: input.rationale.trim(),
      evidenceEventIds: [...new Set(input.evidenceEventIds)].slice(0, 200),
      candidateIds: candidates.map((candidate) => candidate.id),
      status: candidates.some((candidate) => candidate.status === "rejected") ? "partially_rejected" : "proposed",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.batches.push(batch);
    await this.save();
    return { batch: structuredClone(batch), candidates };
  }

  async list(tenantId: string, sessionId?: string): Promise<RefinementBatch[]> {
    await this.load();
    return this.batches
      .filter((batch) => batch.tenantId === tenantId && (!sessionId || batch.sessionId === sessionId))
      .map((batch) => structuredClone(batch));
  }

  async get(id: string): Promise<RefinementBatch> {
    await this.load();
    const batch = this.batches.find((item) => item.id === id);
    if (!batch) throw new Error(`Refinement batch ${id} not found.`);
    return structuredClone(batch);
  }

  async refresh(id: string): Promise<RefinementBatch> {
    await this.load();
    const batch = this.batches.find((item) => item.id === id);
    if (!batch) throw new Error(`Refinement batch ${id} not found.`);
    const candidates = await Promise.all(batch.candidateIds.map(async (candidateId) => await this.governor.get(candidateId)));
    const promoted = candidates.filter((candidate) => candidate.status === "promoted").length;
    const rolledBack = candidates.filter((candidate) => candidate.status === "rolled_back").length;
    if (rolledBack === candidates.length) batch.status = "rolled_back";
    else if (promoted === candidates.length) batch.status = "promoted";
    else if (promoted > 0) batch.status = "partially_promoted";
    else if (candidates.some((candidate) => candidate.status === "rejected")) batch.status = "partially_rejected";
    else batch.status = "proposed";
    batch.updatedAt = new Date().toISOString();
    await this.save();
    return structuredClone(batch);
  }

  async rollback(id: string): Promise<{ batch: RefinementBatch; rolledBackCandidateIds: string[] }> {
    await this.load();
    const batch = this.batches.find((item) => item.id === id);
    if (!batch) throw new Error(`Refinement batch ${id} not found.`);
    const rolledBackCandidateIds: string[] = [];
    for (const candidateId of [...batch.candidateIds].reverse()) {
      const candidate = await this.governor.get(candidateId);
      if (candidate.status !== "promoted") continue;
      await this.governor.rollback(candidateId);
      rolledBackCandidateIds.push(candidateId);
    }
    if (rolledBackCandidateIds.length === 0) throw new Error("Refinement batch has no promoted candidates to roll back.");
    batch.status = rolledBackCandidateIds.length === batch.candidateIds.length ? "rolled_back" : "partially_promoted";
    batch.rollbackAt = new Date().toISOString();
    batch.updatedAt = batch.rollbackAt;
    await this.save();
    return { batch: structuredClone(batch), rolledBackCandidateIds };
  }
}
