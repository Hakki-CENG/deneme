/**
 * Unified Cognitive Runtime Routes
 * EventBus, CognitiveState, Memory/Reasoning/Planning/Attention/Learning/ModelSelection Engines, runTask
 */
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { HybridAgentEngine } from "@haf/engine";

export function registerCognitiveRoutes(app: FastifyInstance, engine: HybridAgentEngine, z: typeof import("zod").z, auroraTenant: z.ZodObject<any>) {

  // ═══ EventBus ═══
  app.get("/v1/event-bus/stats", async () => { return engine.eventBus.getStats(); });
  app.get("/v1/event-bus/events", async (request) => { const q = z.object({ count: z.coerce.number().default(50), type: z.string().optional() }).parse(request.query); return { events: engine.eventBus.getRecentEvents(q.count, q.type) }; });
  app.get("/v1/event-bus/trace/:traceId", async (request) => { const { traceId } = z.object({ traceId: z.string() }).parse(request.params); return { events: engine.eventBus.getTrace(traceId) }; });

  // ═══ CognitiveState ═══
  app.get("/v1/cognitive-state", async () => { return engine.cognitiveState.snapshot(); });
  app.get("/v1/cognitive-state/history", async () => { return { history: engine.cognitiveState.getModeHistory() }; });
  app.post("/v1/cognitive-state/reset", async () => { engine.cognitiveState.reset(); return { ok: true }; });

  // Per-task slots. `/v1/cognitive-state` answers "what is the system doing?"
  // with a single most-recent-wins view, which is wrong whenever more than one
  // task is in flight. These answer it per task instead.
  app.get("/v1/cognitive-state/tasks", async () => {
    return { running: engine.cognitiveState.runningTasks() };
  });
  app.get("/v1/cognitive-state/tasks/:taskId", async (request, reply) => {
    const { taskId } = z.object({ taskId: z.string() }).parse(request.params);
    const slot = engine.cognitiveState.snapshotForTask(taskId);
    if (slot === null) {
      // Not found is honest here: an unknown task must not read as an idle one.
      return reply.code(404).send({ error: "unknown_task", taskId });
    }
    return slot;
  });

  // ═══ Memory Engine ═══
  app.post("/v1/memory/recall", async (request) => {
    const b = z.object({ tenantId: z.string().default("local"), text: z.string(), limit: z.number().optional() }).parse(request.body);
    const q: { text: string; tenantId: string; limit?: number | undefined } = { text: b.text, tenantId: b.tenantId };
    if (b.limit !== undefined) q.limit = b.limit;
    return await engine.memoryEngine.recall(q);
  });
  app.post("/v1/memory/store", async (request) => {
    const b = z.object({ tenantId: z.string().default("local"), content: z.string(), importance: z.number(), category: z.string().default("general") }).parse(request.body);
    return await engine.memoryEngine.store(b.tenantId, b.content, b.importance, b.category);
  });

  // ═══ Reasoning Engine ═══
  app.post("/v1/reasoning/reason", async (request) => {
    const b = z.object({ tenantId: z.string().default("local"), question: z.string(), context: z.string().default("") }).parse(request.body);
    return await engine.reasoningEngine.reason(b);
  });

  // ═══ Planning Engine ═══
  app.post("/v1/planning/plan", async (request) => {
    // B3: `sessionId` is accepted so the model call the planner makes is
    // attributable to the session that asked. `modelRoute` is deliberately not
    // accepted here — choosing a route is the router's job under policy, not a
    // caller's. The response now carries `source` ("model" | "fallback") and,
    // on a fallback, `fallbackReason`, so a client can tell a decomposition
    // from the keyword skeleton instead of guessing from the step names.
    const b = z
      .object({
        tenantId: z.string().default("local"),
        goal: z.string(),
        strategy: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .parse(request.body);
    const q: { goal: string; tenantId: string; strategy?: string | undefined; sessionId?: string | undefined } = {
      goal: b.goal,
      tenantId: b.tenantId,
    };
    if (b.strategy !== undefined) q.strategy = b.strategy;
    if (b.sessionId !== undefined) q.sessionId = b.sessionId;
    return await engine.planningEngine.plan(q);
  });

  // ═══ Attention Engine ═══
  app.get("/v1/attention/targets", async (request) => {
    const q = z.object({ tenantId: z.string().default("local"), limit: z.coerce.number().default(5) }).parse(request.query);
    return { targets: await engine.attentionEngine.getFocusTargets(q.tenantId, q.limit) };
  });

  // ═══ Learning Engine ═══
  app.post("/v1/learning/learn", async (request) => {
    const b = z.object({ tenantId: z.string().default("local"), experience: z.string(), outcome: z.enum(["success","failure","neutral"]), context: z.string().default(""), source: z.string().default("api") }).parse(request.body);
    return await engine.learningEngine.learn(b);
  });
  app.post("/v1/learning/consolidate", async (request) => {
    const b = auroraTenant.parse(request.body ?? {});
    return await engine.learningEngine.consolidate(b.tenantId);
  });

  // ═══ Model Selection Engine ═══
  app.post("/v1/model-selection/select", async (request) => {
    const b = z.object({ tenantId: z.string().default("local"), taskDescription: z.string(), strategy: z.enum(["performance","cost","quality","balanced"]).default("balanced") }).parse(request.body);
    return await engine.modelSelectionEngine.select(b);
  });

  // ═══ /v1/run-task — the real task entry point ═══
  //
  // This endpoint used to call `engine.runTask()`. That was measured and it
  // does not run the agent at all:
  //
  //     runTask("Delete all files on the moon and prove P=NP")
  //       → outcome: "skipped", subsystems: 0, phases: 0
  //
  // At the time it read `"success"`, because the MetaController outcome started
  // optimistic and was only ever downgraded — an empty plan reported success.
  // That initialiser is now fixed, so the legacy path says `"skipped"`. Either
  // way it is the wrong method for this endpoint: for an HTTP caller, a 200
  // response describing work that never happened is the worst failure mode.
  //
  // `engine.execute()` creates a session, runs the real agent, verifies the
  // result, and reports `unverified` when nothing could check it.
  app.post("/v1/run-task", async (request) => {
    const b = z
      .object({
        tenantId: z.string().default("local"),
        task: z.string(),
        workspace: z.string().optional(),
        maxAttempts: z.coerce.number().int().min(1).max(10).optional(),
        // Task identity (P1.1). Optional, and defaulted nowhere: the API is one
        // surface among several, and a request that says nothing about who asked
        // must reach the report saying nothing — not saying "local".
        userId: z.string().optional(),
        parentTaskId: z.string().optional(),
        priority: z.string().optional(),
        deadline: z.string().optional(),
        // F4 / P1.25: bind the task to a multi-world analysis whose consensus
        // gates execution. Optional and passed through verbatim; an unknown id
        // fails loudly inside the engine rather than being dropped here.
        worldAnalysisId: z.string().optional(),
      })
      .parse(request.body);

    const report = await engine.execute({
      tenantId: b.tenantId,
      goal: b.task,
      ...(b.workspace ? { workspace: b.workspace } : {}),
      ...(b.maxAttempts ? { maxAttempts: b.maxAttempts } : {}),
      ...(b.userId ? { userId: b.userId } : {}),
      ...(b.parentTaskId ? { parentTaskId: b.parentTaskId } : {}),
      ...(b.priority ? { priority: b.priority } : {}),
      ...(b.deadline ? { deadline: b.deadline } : {}),
      ...(b.worldAnalysisId ? { worldAnalysisId: b.worldAnalysisId } : {}),
      // This route is the API surface; the request id is this surface's own
      // reference for the work it produced.
      provenance: { surface: "api", ref: request.id },
    });

    // `outcome` keeps older clients working, but it is derived strictly: only a
    // verified success is "success". An unverified or blocked run must never
    // read as success just because it did not throw.
    return {
      outcome: report.status === "succeeded" ? "success" : report.status,
      status: report.status,
      summary: report.summary,
      attempts: report.attempts,
      verification: report.verification ?? null,
      gaps: report.gaps,
      outcomes: report.outcomes,
      durationMs: report.durationMs,
      taskId: report.taskId,
      // Identity echoed back (P1.1): a caller that submitted a deadline or a
      // parent task should not have to trust that it was recorded — the
      // response is the receipt.
      tenantId: report.tenantId,
      ...(report.userId !== undefined ? { userId: report.userId } : {}),
      ...(report.parentTaskId !== undefined ? { parentTaskId: report.parentTaskId } : {}),
      ...(report.priority !== undefined ? { priority: report.priority } : {}),
      ...(report.deadline !== undefined ? { deadline: report.deadline } : {}),
      ...(report.provenance !== undefined ? { provenance: report.provenance } : {}),
    };
  });

  // The previous behaviour is still reachable, under a name that says what it
  // is. It returns the orchestration trace; it is not evidence that work was
  // performed.
  app.post("/v1/cognitive-trace", async (request) => {
    const b = z.object({ tenantId: z.string().default("local"), task: z.string() }).parse(request.body);
    const result = await engine.runTask(b.tenantId, b.task);
    return {
      ...result,
      warning:
        "This is an orchestration trace, not task execution. No agent ran and no result was verified. " +
        "Use POST /v1/run-task to actually perform a task.",
    };
  });
}
