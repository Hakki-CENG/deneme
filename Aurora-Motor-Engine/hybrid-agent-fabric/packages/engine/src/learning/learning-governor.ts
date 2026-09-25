import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "../types.js";
import type { MemoryKind, MemoryScope, MemoryStore } from "../memory/memory-store.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { atomicWrite } from "../util/atomic-file.js";
import type { HybridSearchIndex } from "../search/hybrid-index.js";

export type LearningKind = "memory" | "skill" | "prompt_addendum" | "subagent_spec";
export type LearningScope = "session" | "project" | "user" | "org";
export type LearningStatus = "candidate" | "scanned" | "evaluated" | "approved" | "promoted" | "rejected" | "rolled_back";

export interface LearningCandidate {
  id: string;
  tenantId: string;
  sessionId: string;
  kind: LearningKind;
  scope: LearningScope;
  title: string;
  content: string;
  payload: Record<string, JsonValue>;
  evidenceEventIds: string[];
  expectedOutcome: string;
  risk: "low" | "medium" | "high";
  status: LearningStatus;
  scanFindings: string[];
  evaluation?: { passed: boolean; checks: string[]; summary: string; recordedAt: string };
  review?: { decision: "approve" | "reject"; reviewer: string; reason?: string; reviewedAt: string };
  promotedRef?: { kind: LearningKind; id: string };
  createdBy: "agent" | "user" | "system";
  createdAt: string;
  updatedAt: string;
}

export interface ActiveLearningArtifact {
  id: string;
  candidateId: string;
  tenantId: string;
  sessionId?: string;
  kind: "prompt_addendum" | "subagent_spec";
  scope: LearningScope;
  title: string;
  content: string;
  version: number;
  active: boolean;
  promotedAt: string;
}

const scanRules = [
  { id: "instruction_override", pattern: /ignore\s+(all\s+)?previous\s+instructions/i },
  { id: "secret_exfiltration", pattern: /(?:send|upload|post|exfiltrat).{0,100}(?:secret|token|credential|private key)/i },
  { id: "system_prompt_probe", pattern: /(?:reveal|print|dump).{0,80}system\s+prompt/i },
  { id: "destructive_shell", pattern: /\brm\s+-rf\s+(?:\/|~|\$HOME)/i },
  { id: "invisible_unicode", pattern: /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/ },
];

export class LearningGovernor {
  private candidates: LearningCandidate[] = [];
  private artifacts: ActiveLearningArtifact[] = [];
  private loaded = false;

  constructor(
    private readonly rootPath: string,
    private readonly memories: MemoryStore,
    private readonly skills: SkillRegistry,
    private readonly searchIndex?: HybridSearchIndex,
  ) {}

  private get candidatesPath(): string { return join(this.rootPath, "learning", "candidates.json"); }
  private get artifactsPath(): string { return join(this.rootPath, "learning", "artifacts.json"); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.candidatesPath, "utf8")) as unknown;
      this.candidates = Array.isArray(parsed) ? parsed as LearningCandidate[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const parsed = JSON.parse(await readFile(this.artifactsPath, "utf8")) as unknown;
      this.artifacts = Array.isArray(parsed) ? parsed as ActiveLearningArtifact[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await Promise.all([
      atomicWrite(this.candidatesPath, `${JSON.stringify(this.candidates, null, 2)}\n`),
      atomicWrite(this.artifactsPath, `${JSON.stringify(this.artifacts, null, 2)}\n`),
    ]);
  }

  private scan(content: string): string[] {
    return scanRules.filter((rule) => rule.pattern.test(content)).map((rule) => rule.id);
  }

  async propose(input: {
    tenantId: string;
    sessionId: string;
    kind: LearningKind;
    scope: LearningScope;
    title: string;
    content: string;
    payload?: Record<string, JsonValue>;
    evidenceEventIds: string[];
    expectedOutcome: string;
    risk?: "low" | "medium" | "high";
    createdBy: "agent" | "user" | "system";
  }): Promise<LearningCandidate> {
    await this.load();
    if (!input.title.trim() || !input.content.trim() || !input.expectedOutcome.trim()) throw new Error("Learning title, content and expected outcome are required.");
    if (input.createdBy === "agent" && input.evidenceEventIds.length === 0) throw new Error("Agent-created learning candidates require evidence event IDs.");
    const findings = this.scan(input.content);
    const now = new Date().toISOString();
    const candidate: LearningCandidate = {
      id: randomUUID(),
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      kind: input.kind,
      scope: input.scope,
      title: input.title.trim(),
      content: input.content,
      payload: input.payload ?? {},
      evidenceEventIds: [...new Set(input.evidenceEventIds)].slice(0, 200),
      expectedOutcome: input.expectedOutcome,
      risk: input.risk ?? (input.scope === "org" ? "high" : input.scope === "user" ? "medium" : "low"),
      status: findings.length ? "rejected" : "scanned",
      scanFindings: findings,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.candidates.push(candidate);
    await this.save();
    return structuredClone(candidate);
  }

  async list(tenantId: string, status?: LearningStatus): Promise<LearningCandidate[]> {
    await this.load();
    return this.candidates.filter((item) => item.tenantId === tenantId && (!status || item.status === status)).map((item) => structuredClone(item));
  }

  async get(id: string): Promise<LearningCandidate> {
    await this.load();
    return structuredClone(this.require(id));
  }

  async recordEvaluation(id: string, input: { passed: boolean; checks: string[]; summary: string }): Promise<LearningCandidate> {
    await this.load();
    const candidate = this.require(id);
    if (!["scanned", "evaluated", "approved"].includes(candidate.status)) throw new Error(`Candidate cannot be evaluated from status ${candidate.status}.`);
    const wasApproved = candidate.status === "approved";
    candidate.evaluation = { ...input, checks: input.checks.slice(0, 100), recordedAt: new Date().toISOString() };
    candidate.status = input.passed ? (wasApproved ? "approved" : "evaluated") : "rejected";
    candidate.updatedAt = new Date().toISOString();
    await this.save();
    return structuredClone(candidate);
  }

  async review(id: string, input: { decision: "approve" | "reject"; reviewer: string; reason?: string }): Promise<LearningCandidate> {
    await this.load();
    const candidate = this.require(id);
    if (!["scanned", "evaluated", "approved"].includes(candidate.status)) throw new Error(`Candidate cannot be reviewed from status ${candidate.status}.`);
    candidate.review = {
      decision: input.decision,
      reviewer: input.reviewer,
      ...(input.reason ? { reason: input.reason } : {}),
      reviewedAt: new Date().toISOString(),
    };
    candidate.status = input.decision === "approve" ? "approved" : "rejected";
    candidate.updatedAt = new Date().toISOString();
    await this.save();
    return structuredClone(candidate);
  }

  async promote(id: string): Promise<LearningCandidate> {
    await this.load();
    const candidate = this.require(id);
    const requiresHumanApproval = candidate.scope === "user" || candidate.scope === "org" || candidate.risk === "high";
    if (requiresHumanApproval && candidate.status !== "approved") throw new Error("User/org/high-risk learning requires explicit approval.");
    if (!requiresHumanApproval && candidate.status !== "evaluated" && candidate.status !== "approved") throw new Error("Learning candidate must pass evaluation before promotion.");

    if (candidate.kind === "memory") {
      const memoryKind = typeof candidate.payload.memoryKind === "string" ? candidate.payload.memoryKind as MemoryKind : "semantic";
      const memory = await this.memories.create({
        tenantId: candidate.tenantId,
        ...(candidate.scope === "session" ? { sessionId: candidate.sessionId } : {}),
        kind: memoryKind,
        scope: candidate.scope as MemoryScope,
        title: candidate.title,
        content: candidate.content,
        evidenceEventIds: candidate.evidenceEventIds,
        provenance: { createdBy: candidate.createdBy },
        status: "active",
      });
      candidate.promotedRef = { kind: "memory", id: memory.id };
      await this.searchIndex?.upsert({
        id: `memory:${memory.id}`,
        tenantId: candidate.tenantId,
        kind: "memory",
        text: `${candidate.title}\n${candidate.content}`,
        metadata: { memoryId: memory.id, scope: candidate.scope, candidateId: candidate.id },
      });
    } else if (candidate.kind === "skill") {
      const name = typeof candidate.payload.name === "string" ? candidate.payload.name : candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const skill = await this.skills.createCandidate({
        name,
        description: typeof candidate.payload.description === "string" ? candidate.payload.description : candidate.expectedOutcome,
        content: candidate.content,
        source: `learning:${candidate.id}`,
        createdBy: candidate.createdBy === "agent" ? "agent" : "user",
      });
      if (skill.status !== "quarantine") throw new Error("Skill registry rejected the promoted candidate.");
      const promoted = await this.skills.promote(skill.storageKey);
      candidate.promotedRef = { kind: "skill", id: promoted.name };
      await this.searchIndex?.upsert({
        id: `skill:${promoted.name}`,
        tenantId: candidate.tenantId,
        kind: "skill",
        text: `${candidate.title}\n${candidate.content}`,
        metadata: { skillName: promoted.name, version: promoted.version, candidateId: candidate.id },
      });
    } else {
      const artifact: ActiveLearningArtifact = {
        id: randomUUID(),
        candidateId: candidate.id,
        tenantId: candidate.tenantId,
        ...(candidate.scope === "session" ? { sessionId: candidate.sessionId } : {}),
        kind: candidate.kind,
        scope: candidate.scope,
        title: candidate.title,
        content: candidate.content,
        version: 1,
        active: true,
        promotedAt: new Date().toISOString(),
      };
      this.artifacts.push(artifact);
      candidate.promotedRef = { kind: candidate.kind, id: artifact.id };
      await this.searchIndex?.upsert({
        id: `artifact:${artifact.id}`,
        tenantId: candidate.tenantId,
        kind: "artifact",
        text: `${artifact.title}\n${artifact.content}`,
        metadata: { artifactId: artifact.id, artifactKind: artifact.kind, scope: artifact.scope, candidateId: candidate.id },
      });
    }
    candidate.status = "promoted";
    candidate.updatedAt = new Date().toISOString();
    await this.save();
    return structuredClone(candidate);
  }

  async rollback(id: string): Promise<LearningCandidate> {
    await this.load();
    const candidate = this.require(id);
    if (candidate.status !== "promoted" || !candidate.promotedRef) throw new Error("Only promoted candidates can be rolled back.");
    if (candidate.promotedRef.kind === "memory") await this.memories.deactivate(candidate.promotedRef.id);
    else if (candidate.promotedRef.kind === "skill") await this.skills.deactivate(candidate.promotedRef.id);
    else {
      const artifact = this.artifacts.find((item) => item.id === candidate.promotedRef!.id);
      if (artifact) artifact.active = false;
    }
    const searchId = candidate.promotedRef.kind === "memory"
      ? `memory:${candidate.promotedRef.id}`
      : candidate.promotedRef.kind === "skill"
        ? `skill:${candidate.promotedRef.id}`
        : `artifact:${candidate.promotedRef.id}`;
    await this.searchIndex?.remove(candidate.tenantId, searchId);
    candidate.status = "rolled_back";
    candidate.updatedAt = new Date().toISOString();
    await this.save();
    return structuredClone(candidate);
  }

  async activeArtifacts(tenantId: string, sessionId: string): Promise<ActiveLearningArtifact[]> {
    await this.load();
    return this.artifacts
      .filter((item) => item.active && item.tenantId === tenantId && (item.scope !== "session" || item.sessionId === sessionId))
      .map((item) => structuredClone(item));
  }

  private require(id: string): LearningCandidate {
    const candidate = this.candidates.find((item) => item.id === id);
    if (!candidate) throw new Error(`Learning candidate ${id} not found.`);
    return candidate;
  }
}
