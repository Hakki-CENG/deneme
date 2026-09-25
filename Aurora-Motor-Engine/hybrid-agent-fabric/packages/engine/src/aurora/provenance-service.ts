import { join } from "node:path";
import type { CognitiveWorkspaceService } from "../cognitive/cognitive-workspace-service.js";
import type { EnvironmentAwarenessService } from "../environment/environment-awareness-service.js";
import type { ProactiveInitiativeService } from "../initiative/proactive-initiative-service.js";
import type { MemoryGraphService } from "../memory/memory-graph-service.js";
import type { WorldModelService } from "../world/world-model-service.js";
import type { DecisionService } from "./decision-service.js";
import type { PlanningService } from "./planning-service.js";
import type { ConstitutionService } from "./constitution-service.js";
import { auroraDigest, auroraInteger, auroraRound } from "../util/aurora-state.js";

export type ProvenanceNodeKind =
  | "cognitive-object" | "initiative" | "intake" | "memory" | "world-entity" | "world-event"
  | "environment-action" | "environment-resource" | "decision" | "plan" | "constitution-verdict";

export interface ProvenanceNode {
  kind: ProvenanceNodeKind;
  id: string;
  label: string;
  detail: string;
  confidence?: number;
  createdAt?: string;
  attributes: Record<string, string | number | boolean>;
}

export interface ProvenanceEdge {
  from: string;
  to: string;
  relation: "sourced-from" | "produced" | "verified-by" | "decided-by" | "planned-as" | "recalled" | "constrained-by" | "relates";
  detail: string;
}

export interface ProvenanceTrace {
  tenantId: string;
  rootKind: ProvenanceNodeKind;
  rootId: string;
  nodes: ProvenanceNode[];
  edges: ProvenanceEdge[];
  narrative: string[];
  unresolvedRefs: string[];
  depth: number;
  digest: string;
  generatedAt: string;
}

/**
 * Aurora provenance explainer.
 *
 * Every Aurora subsystem records where its content came from, but the chain only becomes an
 * explanation when it is walked end to end: an environment action points at the goal and plan that
 * justified it, the decision that chose it, the cognitive object that raised it, the initiative or
 * intake signal that started it, and the memories and world state it was reasoned from.
 *
 * This service reconstructs that chain from durable state only. It never asks a model to narrate
 * causality, so the explanation cannot be invented after the fact.
 */
export class ProvenanceService {
  constructor(
    private readonly deps: {
      cognitive: CognitiveWorkspaceService;
      initiative: ProactiveInitiativeService;
      memoryGraph: MemoryGraphService;
      worldModel: WorldModelService;
      environment: EnvironmentAwarenessService;
      decisions: DecisionService;
      planning: PlanningService;
      constitution: ConstitutionService;
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** Explain one artifact by walking its recorded provenance in both directions. */
  async explain(input: { tenantId: string; kind: ProvenanceNodeKind; id: string; depth?: number }): Promise<ProvenanceTrace> {
    const depth = auroraInteger(input.depth ?? 3, 1, 6, "Provenance depth");
    const nodes = new Map<string, ProvenanceNode>();
    const edges: ProvenanceEdge[] = [];
    const unresolved: string[] = [];
    const narrative: string[] = [];
    const seen = new Set<string>();

    const addNode = (node: ProvenanceNode): void => { if (!nodes.has(node.id)) nodes.set(node.id, node); };
    const addEdge = (edge: ProvenanceEdge): void => {
      if (!edges.some((item) => item.from === edge.from && item.to === edge.to && item.relation === edge.relation)) edges.push(edge);
    };

    const walk = async (kind: ProvenanceNodeKind, id: string, level: number): Promise<void> => {
      const marker = `${kind}:${id}`;
      if (level > depth || seen.has(marker)) return;
      seen.add(marker);
      try {
        switch (kind) {
          case "environment-action": {
            const actions = await this.deps.environment.actions(input.tenantId, { limit: 1000 });
            const action = actions.find((item) => item.id === id);
            if (!action) { unresolved.push(marker); return; }
            addNode({
              kind, id: action.id, label: `${action.action} (zone ${action.zone})`, detail: action.goal,
              createdAt: action.createdAt,
              attributes: {
                status: action.status,
                verified: action.verification?.passed ?? false,
                approved: Boolean(action.approval),
                unexpected: action.result?.unexpected ?? false,
                rollbackPlan: Boolean(action.rollbackPlan),
              },
            });
            narrative.push(`Action "${action.action}" ran in zone ${action.zone} with status ${action.status}${action.verification ? ` and verification "${action.verification.method}" (${action.verification.passed ? "passed" : "failed"})` : " and no verification"}.`);
            await walk("environment-resource", action.resourceId, level + 1);
            addEdge({ from: action.id, to: action.resourceId, relation: "relates", detail: "executed against resource" });
            for (const memoryRef of action.memoryUpdateRefs.slice(0, 10)) {
              addEdge({ from: action.id, to: memoryRef, relation: "produced", detail: "memory update" });
              await walk("memory", memoryRef, level + 1);
            }
            break;
          }
          case "environment-resource": {
            const resources = await this.deps.environment.resources(input.tenantId);
            const resource = resources.find((item) => item.id === id);
            if (!resource) { unresolved.push(marker); return; }
            addNode({
              kind, id: resource.id, label: `${resource.kind}: ${resource.name}`, detail: `zone ${resource.zone}`,
              createdAt: resource.createdAt,
              attributes: { status: resource.status, reputation: resource.health.reputation, requiresApproval: resource.requiresApproval },
            });
            break;
          }
          case "cognitive-object": {
            const objects = await this.deps.cognitive.objects(input.tenantId);
            const object = objects.find((item) => item.id === id);
            if (!object) { unresolved.push(marker); return; }
            addNode({
              kind, id: object.id, label: `${object.kind}: ${object.title}`, detail: object.content.slice(0, 500),
              confidence: object.confidence, createdAt: object.createdAt,
              attributes: { state: object.state, attention: object.attentionState, priority: object.priorityScore, horizon: object.horizon, source: object.sourceType },
            });
            narrative.push(`Cognitive object "${object.title}" (${object.kind}, confidence ${object.confidence}) came from ${object.sourceType}${object.sourceId ? ` ${object.sourceId}` : ""}.`);
            if (object.sourceId && object.sourceType !== "user") {
              if (object.tags.includes("initiative")) await walk("initiative", object.sourceId, level + 1);
              else if (object.sourceType === "memory") await walk("memory", object.sourceId, level + 1);
              if (object.sourceId) addEdge({ from: object.id, to: object.sourceId, relation: "sourced-from", detail: object.sourceType });
            }
            for (const relation of object.relations.slice(0, 10)) {
              addEdge({ from: object.id, to: relation, relation: "relates", detail: "declared relation" });
            }
            break;
          }
          case "initiative": {
            const initiatives = await this.deps.initiative.initiatives(input.tenantId, { limit: 1000 });
            const initiative = initiatives.find((item) => item.id === id);
            if (!initiative) { unresolved.push(marker); return; }
            addNode({
              kind, id: initiative.id, label: `${initiative.priority} ${initiative.kind}: ${initiative.title}`,
              detail: initiative.message.slice(0, 500), confidence: initiative.confidence, createdAt: initiative.createdAt,
              attributes: { worthiness: initiative.worthiness, state: initiative.state, channel: initiative.channel, mode: initiative.mode },
            });
            narrative.push(`Initiative "${initiative.title}" scored worthiness ${initiative.worthiness} and was routed to ${initiative.channel} (${initiative.state}).`);
            for (const intakeId of initiative.intakeEventIds.slice(0, 5)) {
              addEdge({ from: initiative.id, to: intakeId, relation: "sourced-from", detail: "intake event" });
              await walk("intake", intakeId, level + 1);
            }
            break;
          }
          case "intake": {
            const events = await this.deps.initiative.intakeEvents(input.tenantId, { limit: 1000 });
            const event = events.find((item) => item.id === id);
            if (!event) { unresolved.push(marker); return; }
            addNode({
              kind, id: event.id, label: `${event.source} signal`, detail: event.summary,
              createdAt: event.occurredAt, attributes: { processed: event.processed, digest: event.payloadDigest.slice(0, 16) },
            });
            narrative.push(`Signal from ${event.source} at ${event.occurredAt}: ${event.summary}`);
            break;
          }
          case "memory": {
            const memory = await this.deps.memoryGraph.get(input.tenantId, id).catch(() => undefined);
            if (!memory) { unresolved.push(marker); return; }
            addNode({
              kind, id: memory.id, label: `${memory.layer}/${memory.claimType}: ${memory.title}`,
              detail: memory.content.slice(0, 500), confidence: memory.confidence, createdAt: memory.createdAt,
              attributes: { importance: memory.importance, state: memory.state, source: memory.sourceType, usage: memory.usageCount },
            });
            narrative.push(`Memory "${memory.title}" is a ${memory.claimType} from ${memory.sourceType} with confidence ${memory.confidence}.`);
            if (level < depth) {
              const neighborhood = await this.deps.memoryGraph.neighborhood(input.tenantId, memory.id, 1, 8);
              for (const relation of neighborhood.relations.slice(0, 8)) {
                addEdge({ from: relation.fromId, to: relation.toId, relation: relation.type === "derived-from" ? "sourced-from" : "relates", detail: `${relation.type} (${relation.strength})` });
              }
              for (const neighbor of neighborhood.memories.filter((item) => item.id !== memory.id).slice(0, 5)) {
                addNode({
                  kind: "memory", id: neighbor.id, label: `${neighbor.layer}/${neighbor.claimType}: ${neighbor.title}`,
                  detail: neighbor.content.slice(0, 200), confidence: neighbor.confidence, createdAt: neighbor.createdAt,
                  attributes: { importance: neighbor.importance, state: neighbor.state },
                });
              }
            }
            break;
          }
          case "world-entity": {
            const entities = await this.deps.worldModel.entities(input.tenantId);
            const entity = entities.find((item) => item.id === id);
            if (!entity) { unresolved.push(marker); return; }
            const state = await this.deps.worldModel.stateAt(input.tenantId, entity.id);
            addNode({
              kind, id: entity.id, label: `${entity.type}: ${entity.name}`,
              detail: Object.values(state).map((fact) => `${fact.key}=${fact.value}`).join(", ").slice(0, 500),
              confidence: entity.confidence, createdAt: entity.createdAt,
              attributes: { scope: entity.scope, importance: entity.importance, facts: Object.keys(state).length },
            });
            break;
          }
          case "world-event": {
            const events = await this.deps.worldModel.events(input.tenantId, 500);
            const event = events.find((item) => item.id === id);
            if (!event) { unresolved.push(marker); return; }
            addNode({
              kind, id: event.id, label: "world event", detail: event.summary,
              confidence: event.confidence, createdAt: event.occurredAt,
              attributes: { importance: event.importance, source: event.sourceType, entities: event.entityIds.length },
            });
            for (const entityId of event.entityIds.slice(0, 5)) {
              addEdge({ from: event.id, to: entityId, relation: "relates", detail: "participant" });
              await walk("world-entity", entityId, level + 1);
            }
            break;
          }
          case "decision": {
            const decision = await this.deps.decisions.get(input.tenantId, id).catch(() => undefined);
            if (!decision) { unresolved.push(marker); return; }
            const chosen = decision.options.find((item) => item.id === decision.chosenOptionId);
            addNode({
              kind, id: decision.id, label: `decision: ${decision.title}`,
              detail: `${decision.question} -> ${chosen?.name ?? "undecided"}`,
              confidence: decision.confidence, createdAt: decision.createdAt,
              attributes: {
                status: decision.status, margin: decision.margin, options: decision.options.length,
                dissent: decision.dissent.length, reversibility: decision.reversibility,
                ...(decision.outcome ? { succeeded: decision.outcome.succeeded, surprise: decision.outcome.surprise } : {}),
              },
            });
            narrative.push(`Decision "${decision.title}" chose ${chosen?.name ?? "nothing yet"} with confidence ${decision.confidence} over ${decision.options.length} option(s), margin ${decision.margin}, ${decision.dissent.length} recorded dissent(s).`);
            if (decision.constitutionVerdictId) {
              addEdge({ from: decision.id, to: decision.constitutionVerdictId, relation: "constrained-by", detail: `constitution ${decision.constitutionVerdict ?? "checked"}` });
              await walk("constitution-verdict", decision.constitutionVerdictId, level + 1);
            }
            for (const goalId of decision.goalIds.slice(0, 5)) addEdge({ from: decision.id, to: goalId, relation: "relates", detail: "goal" });
            break;
          }
          case "plan": {
            const plan = await this.deps.planning.get(input.tenantId, id).catch(() => undefined);
            if (!plan) { unresolved.push(marker); return; }
            addNode({
              kind, id: plan.id, label: `plan v${plan.version}: ${plan.title}`, detail: plan.objective.slice(0, 500),
              createdAt: plan.createdAt,
              attributes: {
                status: plan.status, progress: plan.progress, steps: plan.steps.length,
                revisions: plan.revisions.length, criticalPath: plan.criticalPath.length,
              },
            });
            narrative.push(`Plan "${plan.title}" is at version ${plan.version} with ${auroraRound(plan.progress * 100, 0)}% of ${plan.steps.length} step(s) done across ${plan.revisions.length} revision(s).`);
            if (plan.decisionId) {
              addEdge({ from: plan.id, to: plan.decisionId, relation: "decided-by", detail: "originating decision" });
              await walk("decision", plan.decisionId, level + 1);
            }
            if (plan.goalId) addEdge({ from: plan.id, to: plan.goalId, relation: "relates", detail: "goal" });
            break;
          }
          case "constitution-verdict": {
            const decisions = await this.deps.constitution.decisions(input.tenantId, { limit: 1000 });
            const verdict = decisions.find((item) => item.id === id);
            if (!verdict) { unresolved.push(marker); return; }
            addNode({
              kind, id: verdict.id, label: `constitution: ${verdict.verdict}`, detail: verdict.summary,
              createdAt: verdict.decidedAt,
              attributes: { violations: verdict.violations.length, satisfied: verdict.satisfied.length, identityVersion: verdict.identityVersion },
            });
            narrative.push(`Constitutional review returned "${verdict.verdict}"${verdict.violations.length ? ` citing ${verdict.violations.map((item) => item.code).join(", ")}` : " with no violations"}.`);
            break;
          }
          default:
            unresolved.push(marker);
        }
      } catch {
        unresolved.push(marker);
      }
    };

    await walk(input.kind, input.id, 0);
    const nodeList = [...nodes.values()];
    return {
      tenantId: input.tenantId,
      rootKind: input.kind,
      rootId: input.id,
      nodes: nodeList,
      edges: edges.filter((edge) => nodes.has(edge.from)),
      narrative,
      unresolvedRefs: [...new Set(unresolved)],
      depth,
      digest: auroraDigest(nodeList.map((item) => `${item.kind}:${item.id}`).sort().join("|")),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  // ═══ P3: Stats ═══

  getStats() {
    return { status: "active" };
  }

  // ═══ P3: Explainability ═══

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    return { entity: entityId, summary: "N/A", rationale: ["Service does not support entity lookup"], details: {} };
  }
}




/** Convenience for callers that only need a human-readable answer to "why did you do that?". */
export function narrateProvenance(trace: ProvenanceTrace): string {
  if (!trace.narrative.length) return `No recorded provenance for ${trace.rootKind} ${trace.rootId}.`;
  return trace.narrative.join("\n");
}
