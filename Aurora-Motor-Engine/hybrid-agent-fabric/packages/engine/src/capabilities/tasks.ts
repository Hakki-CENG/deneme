import { z } from "zod";
import type { Supervisor } from "../runtime/supervisor.js";
import { defineCapability } from "./schema.js";

const status = z.enum(["backlog", "ready", "in_progress", "blocked", "review", "done", "cancelled"]);
const priority = z.enum(["low", "normal", "high", "critical"]);

export function taskCapabilities(supervisor: Supervisor) {
  return [
    defineCapability(
      {
        id: "task.list",
        version: "1.0.0",
        description: "List the durable task board for this session, optionally filtered by status.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ status: status.optional() }),
      async (input, context) => await supervisor.taskActionFromCapability(context.sessionId, "list", input as unknown as Record<string, import("../types.js").JsonValue>, context.turnId),
    ),
    defineCapability(
      {
        id: "task.create",
        version: "1.0.0",
        description: "Create a durable task with priority, dependencies, status and optional child-agent assignment.",
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({
        title: z.string().min(1).max(300),
        description: z.string().max(20_000).optional(),
        status: status.optional(),
        priority: priority.optional(),
        dependsOn: z.array(z.string()).max(50).optional(),
        assigneeSessionId: z.string().optional(),
      }),
      async (input, context) => await supervisor.taskActionFromCapability(context.sessionId, "create", input as unknown as Record<string, import("../types.js").JsonValue>, context.turnId),
    ),
    defineCapability(
      {
        id: "task.update",
        version: "1.0.0",
        description: "Update a durable task. Dependency cycles are rejected and blocked tasks auto-unblock when prerequisites finish.",
        risk: "pure",
        sideEffect: true,
        source: "core",
      },
      z.object({
        id: z.string().min(1),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(20_000).nullable().optional(),
        status: status.optional(),
        priority: priority.optional(),
        dependsOn: z.array(z.string()).max(50).optional(),
        assigneeSessionId: z.string().nullable().optional(),
      }),
      async (input, context) => await supervisor.taskActionFromCapability(context.sessionId, "update", input as unknown as Record<string, import("../types.js").JsonValue>, context.turnId),
    ),
  ];
}
