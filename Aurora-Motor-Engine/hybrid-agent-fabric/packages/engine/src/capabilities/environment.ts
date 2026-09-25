import { z } from "zod";
import type { EnvironmentProbe } from "../embodiment/environment-probe.js";
import type { EnvironmentAwarenessService } from "../environment/environment-awareness-service.js";
import { defineCapability } from "./schema.js";

const unit = z.number().min(0).max(1);
const zone = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const resourceKind = z.enum(["filesystem", "terminal", "ide", "browser", "git", "database", "api", "device", "cloud", "calendar", "channel", "kernel", "sandbox", "mcp-server"]);

/**
 * Aurora Phase G capabilities: environment inventory, action records with mandatory verification,
 * tool execution reputation, workspace habits and project awareness.
 * This layer records and governs; execution still goes through the capability broker and policy engine.
 */
export function environmentCapabilities(service: EnvironmentAwarenessService, probe?: EnvironmentProbe, catalog?: () => Array<{ risk: string }>) {
  return [
    defineCapability(
      { id: "environment.resource.register", version: "1.0.0", description: "Register an environment resource with its safe execution zone (0-4), capability IDs and approval requirement.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ kind: resourceKind, name: z.string().min(1).max(200), locator: z.string().min(1).max(2000), zone, capabilityIds: z.array(z.string()).max(100).optional(), requiresApproval: z.boolean().optional(), tags: z.array(z.string()).max(100).optional() }),
      async (input, ctx) => await service.registerResource({
        tenantId: ctx.tenantId, kind: input.kind, name: input.name, locator: input.locator, zone: input.zone,
        ...(input.capabilityIds ? { capabilityIds: input.capabilityIds } : {}), ...(input.requiresApproval !== undefined ? { requiresApproval: input.requiresApproval } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
      }),
    ),
    defineCapability(
      { id: "environment.resources.list", version: "1.0.0", description: "List environment resources with health, reputation and zone.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ kind: resourceKind.optional(), status: z.enum(["available", "degraded", "unavailable", "retired"]).optional(), maxZone: zone.optional() }),
      async (input, ctx) => ({ resources: await service.resources(ctx.tenantId, { ...(input.kind ? { kind: input.kind } : {}), ...(input.status ? { status: input.status } : {}), ...(input.maxZone !== undefined ? { maxZone: input.maxZone } : {}) }) }),
    ),
    defineCapability(
      { id: "environment.resource.status", version: "1.0.0", description: "Update the availability status of an environment resource.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ resourceId: z.string(), status: z.enum(["available", "degraded", "unavailable", "retired"]), note: z.string().max(1000).optional() }),
      async (input, ctx) => await service.setResourceStatus(ctx.tenantId, input.resourceId, input.status, input.note),
    ),
    defineCapability(
      { id: "environment.action.plan", version: "1.0.0", description: "Open a standard Aurora action record: goal, plan, action, expected outcome and rollback plan. Zone 3+ requires a rollback plan.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ resourceId: z.string(), goal: z.string().min(1).max(5000), plan: z.array(z.string()).min(1).max(50), action: z.string().min(1).max(2000), parameters: z.record(z.unknown()).optional(), expectedOutcome: z.string().min(1).max(5000), rollbackPlan: z.string().max(5000).optional(), rollbackCheckpointId: z.string().max(300).optional() }),
      async (input, ctx) => await service.planAction({
        tenantId: ctx.tenantId, sessionId: ctx.sessionId, resourceId: input.resourceId, goal: input.goal, plan: input.plan, action: input.action, expectedOutcome: input.expectedOutcome,
        ...(input.parameters ? { parameters: input.parameters } : {}), ...(input.rollbackPlan ? { rollbackPlan: input.rollbackPlan } : {}),
        ...(input.rollbackCheckpointId ? { rollbackCheckpointId: input.rollbackCheckpointId } : {}),
      }),
    ),
    defineCapability(
      { id: "environment.action.approve", version: "1.0.0", description: "Approve a planned action for a resource that requires human authorization.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ actionId: z.string(), actor: z.string().min(1).max(200), reason: z.string().min(1).max(2000) }),
      async (input, ctx) => await service.approveAction({ tenantId: ctx.tenantId, ...input }),
    ),
    defineCapability(
      { id: "environment.action.start", version: "1.0.0", description: "Mark an action as executing. Approval-required resources refuse to start without approval.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ actionId: z.string() }),
      async (input, ctx) => await service.startAction(ctx.tenantId, input.actionId),
    ),
    defineCapability(
      { id: "environment.action.complete", version: "1.0.0", description: "Record the outcome of an action, flagging unexpected results, and update the resource's execution reputation.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ actionId: z.string(), success: z.boolean(), summary: z.string().min(1).max(20_000), durationMs: z.number().int().min(0), unexpected: z.boolean().optional() }),
      async (input, ctx) => await service.completeAction({
        tenantId: ctx.tenantId, actionId: input.actionId, success: input.success, summary: input.summary, durationMs: input.durationMs,
        ...(input.unexpected !== undefined ? { unexpected: input.unexpected } : {}),
      }),
    ),
    defineCapability(
      { id: "environment.action.verify", version: "1.0.0", description: "Mandatory verification step with method, outcome, evidence and the memory updates it produced.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ actionId: z.string(), method: z.string().min(1).max(500), passed: z.boolean(), evidenceRefs: z.array(z.string()).max(200).optional(), note: z.string().max(5000).optional(), memoryUpdateRefs: z.array(z.string()).max(100).optional() }),
      async (input, ctx) => await service.verifyAction({
        tenantId: ctx.tenantId, actionId: input.actionId, method: input.method, passed: input.passed,
        ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}), ...(input.note ? { note: input.note } : {}), ...(input.memoryUpdateRefs ? { memoryUpdateRefs: input.memoryUpdateRefs } : {}),
      }),
    ),
    defineCapability(
      { id: "environment.action.rollback", version: "1.0.0", description: "Record execution of the rollback plan for a finished action.", risk: "privileged", sideEffect: true, source: "core" },
      z.object({ actionId: z.string(), reason: z.string().min(1).max(5000), restoredCheckpointId: z.string().max(300).optional() }),
      async (input, ctx) => await service.rollbackAction({ tenantId: ctx.tenantId, actionId: input.actionId, reason: input.reason, ...(input.restoredCheckpointId ? { restoredCheckpointId: input.restoredCheckpointId } : {}) }),
    ),
    defineCapability(
      { id: "environment.actions.list", version: "1.0.0", description: "List Aurora action records with their verification state.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ status: z.enum(["planned", "approved", "executing", "completed", "verified", "failed", "rolled-back"]).optional(), resourceId: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() }),
      async (input, ctx) => ({ actions: await service.actions(ctx.tenantId, { ...(input.status ? { status: input.status } : {}), ...(input.resourceId ? { resourceId: input.resourceId } : {}), ...(input.limit ? { limit: input.limit } : {}) }) }),
    ),
    defineCapability(
      { id: "environment.actions.unverified", version: "1.0.0", description: "List completed actions that were never verified (verification debt).", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => ({ actions: await service.unverifiedActions(ctx.tenantId) }),
    ),
    defineCapability(
      { id: "environment.project.upsert", version: "1.0.0", description: "Track continuous project awareness: workspace, open tasks, risks, progress and last activity.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ name: z.string().min(1).max(200), workspacePath: z.string().min(1).max(2000), repositoryRef: z.string().max(500).optional(), openTasks: z.number().int().min(0).max(100_000).optional(), risks: z.array(z.string()).max(50).optional(), progress: unit.optional(), status: z.enum(["active", "paused", "archived"]).optional(), lastActivityAt: z.string().datetime().optional() }),
      async (input, ctx) => await service.upsertProject({
        tenantId: ctx.tenantId, name: input.name, workspacePath: input.workspacePath,
        ...(input.repositoryRef ? { repositoryRef: input.repositoryRef } : {}), ...(input.openTasks !== undefined ? { openTasks: input.openTasks } : {}),
        ...(input.risks ? { risks: input.risks } : {}), ...(input.progress !== undefined ? { progress: input.progress } : {}),
        ...(input.status ? { status: input.status } : {}), ...(input.lastActivityAt ? { lastActivityAt: input.lastActivityAt } : {}),
      }),
    ),
    defineCapability(
      { id: "environment.projects.stale", version: "1.0.0", description: "List active projects with no activity in the given window; the project watcher's input.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ days: z.number().int().min(1).max(365).optional() }),
      async (input, ctx) => ({ projects: await service.staleProjects(ctx.tenantId, input.days ?? 7) }),
    ),
    defineCapability(
      { id: "environment.habit.record", version: "1.0.0", description: "Record a digital workspace habit with its observed success rate.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ scope: z.string().min(1).max(300), pattern: z.string().min(1).max(500), success: z.boolean() }),
      async (input, ctx) => await service.recordHabit({ tenantId: ctx.tenantId, ...input }),
    ),
    defineCapability(
      { id: "environment.habits.list", version: "1.0.0", description: "List learned workspace habits ranked by frequency.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ scope: z.string().max(300).optional() }),
      async (input, ctx) => ({ habits: await service.habits(ctx.tenantId, input.scope) }),
    ),
    defineCapability(
      { id: "environment.inventory", version: "1.0.0", description: "Environment inventory: resource counts by kind and zone, low-reputation tools, verification debt and unexpected outcomes.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async (_input, ctx) => await service.inventory(ctx.tenantId),
    ),
    ...(probe
      ? [
          defineCapability(
            {
              id: "environment.probe",
              version: "1.0.0",
              description: "Measure the execution environment: installed interpreters and tool versions, device state (disk, CPU, memory), project structure and language mix, and the capability catalog's risk distribution. Every fact is measured in the session sandbox; network reachability is deliberately not probed and the report says so.",
              risk: "process",
              sideEffect: false,
              source: "core",
            },
            z.object({ refresh: z.boolean().optional() }),
            async (input, context) => {
              const report = await probe.probe(context.workspacePath, input.refresh ? { refresh: true } : {});
              // Permissions, honestly scoped: what this agent may be offered,
              // summarised from the live capability catalog by risk class.
              const descriptors = catalog ? catalog() : [];
              const byRisk: Record<string, number> = {};
              for (const descriptor of descriptors) byRisk[descriptor.risk] = (byRisk[descriptor.risk] ?? 0) + 1;
              return { ...report, permissions: { capabilityCount: descriptors.length, byRisk } };
            },
          ),
        ]
      : []),
  ];
}
