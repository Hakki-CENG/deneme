/**
 * Embodiment Capabilities
 * Bridges FileSystemAgent and ActionFramework to the CapabilityBroker.
 *
 * Content search is deliberately not here. `embodiment.fs.search` used to wrap
 * `FileSystemAgent.searchContent`, but `filesystem.grep` already covered the same
 * ground and more -- regex, include patterns, case folding, match caps and
 * context lines against a plain text query. Two ways to search file contents
 * meant an agent could pick the weaker one and get a worse answer, so the subset
 * was removed rather than kept alongside.
 * Enables Aurora to interact with the file system and execute multi-step action plans.
 */

import { z } from "zod";
import { defineCapability } from "./schema.js";
import { FileSystemAgent } from "../embodiment/filesystem-agent.js";
import type { ActionFramework } from "../embodiment/action-framework.js";

/**
 * The agent a call should run against.
 *
 * `fileSystemAgentCapabilities` is handed one agent, rooted at the engine's home
 * workspaces directory. A session's workspace is usually somewhere else entirely,
 * so binding that agent directly made every `embodiment.fs.*` call resolve
 * against the wrong root: `embodiment.fs.info {"path":"package.json"}` looked in
 * <home>/workspaces/ and threw ENOENT however the session was configured. The
 * capability context carries the session's workspace, so the call is scoped to
 * it, and falls back to the shared agent when the session has none.
 *
 * Measured before this fix: the call failed, and the module still counted as
 * exercised, because `resolveSafePath` runs before the ENOENT. A capability that
 * throws on every invocation is not working, and coverage cannot tell the
 * difference on its own.
 *
 * A per-call agent is cheap: the constructor resolves a path and merges config.
 */
function agentFor(defaultAgent: FileSystemAgent, workspacePath: string | undefined): FileSystemAgent {
  return workspacePath ? new FileSystemAgent(workspacePath) : defaultAgent;
}

/**
 * Creates file system embodiment capabilities that wrap the FileSystemAgent.
 * These capabilities provide safe, policy-governed access to file operations
 * beyond the basic read/write in the core filesystem capabilities.
 */
export function fileSystemAgentCapabilities(agent: FileSystemAgent) {
  return [
    defineCapability(
      {
        id: "embodiment.fs.find",
        version: "1.0.0",
        description: "Find files by glob pattern using the File System Agent.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      z.object({
        pattern: z.string().min(1).max(500),
      }),
      async ({ pattern }, context) => {
        const results = await agentFor(agent, context.workspacePath).findFiles(pattern);
        return { pattern, results, count: results.length };
      },
    ),

    defineCapability(
      {
        id: "embodiment.fs.info",
        version: "1.0.0",
        description: "Get detailed file information using the File System Agent.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      z.object({
        path: z.string().min(1),
      }),
      async ({ path }, context) => {
        const info = await agentFor(agent, context.workspacePath).getFileInfo(path);
        return info;
      },
    ),

    defineCapability(
      {
        id: "embodiment.fs.mkdir",
        version: "1.0.0",
        description: "Create a directory (with parents) using the File System Agent.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        path: z.string().min(1),
      }),
      async ({ path }, context) => {
        await agentFor(agent, context.workspacePath).createDirectory(path);
        return { created: path };
      },
    ),

    defineCapability(
      {
        id: "embodiment.fs.delete",
        version: "1.0.0",
        description: "Delete a file using the File System Agent.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        path: z.string().min(1),
      }),
      async ({ path }, context) => {
        await agentFor(agent, context.workspacePath).deleteFile(path);
        return { deleted: path };
      },
    ),

    defineCapability(
      {
        id: "embodiment.fs.rename",
        version: "1.0.0",
        description: "Rename or move a file using the File System Agent.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        oldPath: z.string().min(1),
        newPath: z.string().min(1),
      }),
      async ({ oldPath, newPath }, context) => {
        await agentFor(agent, context.workspacePath).renameFile(oldPath, newPath);
        return { from: oldPath, to: newPath };
      },
    ),

    defineCapability(
      {
        id: "embodiment.fs.copy",
        version: "1.0.0",
        description: "Copy a file using the File System Agent.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        source: z.string().min(1),
        destination: z.string().min(1),
      }),
      async ({ source, destination }, context) => {
        await agentFor(agent, context.workspacePath).copyFile(source, destination);
        return { from: source, to: destination };
      },
    ),
  ];
}

/**
 * Creates action framework capabilities that wrap the ActionFramework.
 * These capabilities enable Aurora to plan, execute, and verify multi-step actions.
 */
export function actionFrameworkCapabilities(framework: ActionFramework) {
  return [
    defineCapability(
      {
        id: "embodiment.action.create_goal",
        version: "1.0.0",
        description: "Create a new goal in the action framework.",
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().min(1).max(2000),
        priority: z.enum(["P0", "P1", "P2", "P3", "P4"]).default("P2"),
        successCriteria: z.array(z.string()).default([]),
        constraints: z.array(z.string()).default([]),
        deadline: z.string().optional(),
      }),
      async (input, context) => {
        const goalInput: {
          title: string;
          description: string;
          priority: "P0" | "P1" | "P2" | "P3" | "P4";
          successCriteria: string[];
          constraints: string[];
          deadline?: string;
        } = {
          title: input.title,
          description: input.description,
          priority: input.priority,
          successCriteria: input.successCriteria,
          constraints: input.constraints,
        };
        if (input.deadline !== undefined) goalInput.deadline = input.deadline;
        return framework.createGoal({ tenantId: context.tenantId, ...goalInput });
      },
    ),

    defineCapability(
      {
        id: "embodiment.action.accept_goal",
        version: "1.0.0",
        description: "Accept a proposed goal.",
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({
        goalId: z.string().min(1),
      }),
      async ({ goalId }) => {
        const goal = await framework.acceptGoal(goalId);
        return goal;
      },
    ),

    defineCapability(
      {
        id: "embodiment.action.create_plan",
        version: "1.0.0",
        description: "Create an execution plan for a goal.",
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({
        goalId: z.string().min(1),
        title: z.string().min(1).max(200),
        description: z.string().min(1).max(2000),
        steps: z.array(z.object({
          title: z.string().min(1).max(200),
          description: z.string().min(1).max(500),
          actionType: z.string().min(1).max(100),
          input: z.record(z.unknown()).default({}),
          expectedOutput: z.string().default(""),
          dependsOn: z.array(z.number().int().nonnegative()).default([]),
        })),
        riskLevel: z.enum(["low", "medium", "high", "critical"]).default("low"),
      }),
      async (input, context) => {
        const plan = framework.createPlan({ tenantId: context.tenantId, ...input });
        return plan;
      },
    ),

    defineCapability(
      {
        id: "embodiment.action.approve_plan",
        version: "1.0.0",
        description: "Approve a plan for execution.",
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({
        planId: z.string().min(1),
      }),
      async ({ planId }) => {
        const plan = await framework.approvePlan(planId);
        return plan;
      },
    ),

    defineCapability(
      {
        id: "embodiment.action.record_result",
        version: "1.0.0",
        description: "Record the result of a plan step execution.",
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({
        planId: z.string().min(1),
        stepId: z.string().min(1),
        success: z.boolean(),
        output: z.unknown().default(null),
        error: z.string().optional(),
        durationMs: z.number().int().nonnegative().default(0),
        tokensUsed: z.number().int().nonnegative().default(0),
        sideEffects: z.array(z.string()).default([]),
      }),
      async ({ planId, stepId, ...rest }) => {
        const result: {
          success: boolean;
          output: unknown;
          error?: string;
          durationMs: number;
          tokensUsed: number;
          sideEffects: string[];
          verificationNeeded: boolean;
          evidence: string[];
        } = {
          success: rest.success,
          output: rest.output,
          durationMs: rest.durationMs,
          tokensUsed: rest.tokensUsed,
          sideEffects: rest.sideEffects,
          verificationNeeded: true,
          evidence: [],
        };
        if (rest.error !== undefined) result.error = rest.error;
        await framework.recordStepResult(planId, stepId, result);
        return { recorded: true, planId, stepId };
      },
    ),

    defineCapability(
      {
        id: "embodiment.action.list_goals",
        version: "1.0.0",
        description: "List all goals in the action framework.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async () => {
        return framework.getGoals();
      },
    ),

    defineCapability(
      {
        id: "embodiment.action.list_plans",
        version: "1.0.0",
        description: "List all plans, optionally filtered by goal.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({
        goalId: z.string().optional(),
      }),
      async ({ goalId }) => {
        if (goalId) return framework.getPlansForGoal(goalId);
        return framework.getPlans();
      },
    ),

    defineCapability(
      {
        id: "embodiment.action.stats",
        version: "1.0.0",
        description: "Get action framework statistics.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async () => {
        return framework.getStats();
      },
    ),
  ];
}
