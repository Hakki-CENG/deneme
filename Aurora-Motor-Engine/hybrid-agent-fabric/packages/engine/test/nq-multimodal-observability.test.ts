import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { AudioService } from "../src/audio/audio-service.js";
import { HealthService } from "../src/observability/health-service.js";
import { SloService } from "../src/observability/slo-service.js";
import { explainTask } from "../src/observability/task-explain.js";
import { MemoryEventStore } from "../src/persistence/event-store.js";
import type { EventEnvelope, EventStore } from "../src/persistence/event-store.js";
import { MultimodalService } from "../src/multimodal/multimodal-service.js";
import type { TaskReport } from "../src/execution/unified-execution-loop.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** A store that hands its listener straight to the service under test. */
function fakeEventStore(): { store: EventStore; push: (type: string, payload: Record<string, unknown>, timestamp?: string, turnId?: string) => void } {
  let listener: ((event: EventEnvelope) => void) | undefined;
  const store: EventStore = {
    subscribeAll: (l) => {
      listener = l;
      return () => { listener = undefined; };
    },
  } as unknown as EventStore;
  let sequence = 0;
  const push = (type: string, payload: Record<string, unknown>, timestamp?: string, turnId?: string) => {
    sequence += 1;
    listener?.({
      schemaVersion: 1,
      eventId: `evt-${sequence}`,
      tenantId: "t",
      sessionId: "s",
      familyId: "f",
      generation: 1,
      sequence,
      ...(turnId ? { turnId } : {}),
      traceId: "trace",
      type,
      timestamp: timestamp ?? new Date().toISOString(),
      visibility: "audit",
      redactionClass: "metadata-only",
      payload,
    });
  };
  return { store, push };
}

function envelopeTimestamp(offsetMs: number): string {
  return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

// ═══ N1/N2: STT/TTS latency is measured, not asserted ═══

describe("N1/N2 — STT/TTS measured latency", () => {
  it("reports the real round-trip duration for transcription and synthesis", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nq-audio-"));
    await writeFile(join(workspace, "memo.wav"), Buffer.from("fake-wave"));
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
      expect(init?.body).toBeInstanceOf(FormData);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
    }) as typeof fetch;
    const service = new AudioService({ apiKey: "k", transcriptionModel: "m" });
    const transcribed = await service.transcribe({ workspacePath: workspace, path: "memo.wav" });
    expect(transcribed.durationMs).toBeGreaterThanOrEqual(35);

    globalThis.fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(Buffer.from("audio"), { status: 200 });
    }) as typeof fetch;
    const spoken = await service.synthesize({ workspacePath: workspace, text: "hi", outputPath: "out.mp3" });
    expect(spoken.durationMs).toBeGreaterThanOrEqual(25);
  });
});

// ═══ N3: legacy multimodal entry points refuse instead of pretending ═══

describe("N3 — multimodal honesty", () => {
  it("analyzeImage and analyzeVideo refuse without a backend instead of returning empty successes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nq-mm-"));
    const service = new MultimodalService(root);
    await service.init();
    await expect(service.analyzeImage("t", "x.png")).rejects.toThrow(/vision backend/);
    await expect(service.analyzeVideo("t", "x.mp4")).rejects.toThrow(/frame/);
    await expect(service.performOCR("t", "x.png")).rejects.toThrow(MultimodalService.prototype instanceof Error ? /OCR|backend/ : /backend/);
  });
});

// ═══ N4: multimodal memory with verified provenance ═══

describe("N4 — multimodal memory attachments", () => {
  it("stores a memory with hash-verified media evidence and refuses a swapped file", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "nq-mem-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      autoApproveWorkspaceWrites: true,
      model: { provider: "mock" },
    });
    const session = await engine.createSession({ tenantId: "t" }) as { sessionId: string; workspacePath: string };
    const imageBytes = Buffer.from("png-bytes-here");
    await writeFile(join(session.workspacePath, "evidence.png"), imageBytes);
    const digest = createHash("sha256").update(imageBytes).digest("hex");

    const created = await engine.capabilities.execute("memory.propose", {
      kind: "semantic",
      title: "The dashboard screenshot shows the bug",
      content: "The error banner appears in the top-right corner of the dashboard.",
      evidenceEventIds: [],
      attachments: [{ path: "evidence.png", mimeType: "image/png", sha256: digest, kind: "image", confidence: 0.8 }],
    }, {
      tenantId: "t", sessionId: session.sessionId, familyId: session.sessionId, turnId: "turn",
      toolCallId: "tc", source: "api", workspacePath: session.workspacePath, idempotencyKey: "nq-1",
    }) as { attachments?: Array<{ bytes: number; sha256: string; confidence: number }> };
    expect(created.attachments?.[0]?.sha256).toBe(digest);
    expect(created.attachments?.[0]?.bytes).toBe(imageBytes.length);
    expect(created.attachments?.[0]?.confidence).toBe(0.8);

    // The evidence file is swapped afterwards: the claimed hash no longer matches.
    await writeFile(join(session.workspacePath, "evidence.png"), Buffer.from("tampered"));
    await expect(engine.capabilities.execute("memory.propose", {
      kind: "semantic",
      title: "Another claim about the same image",
      content: "claim",
      evidenceEventIds: [],
      attachments: [{ path: "evidence.png", mimeType: "image/png", sha256: digest, kind: "image", confidence: 0.8 }],
    }, {
      tenantId: "t", sessionId: session.sessionId, familyId: session.sessionId, turnId: "turn",
      toolCallId: "tc2", source: "api", workspacePath: session.workspacePath, idempotencyKey: "nq-2",
    })).rejects.toThrow(/hash mismatch/);

    // Workspace escape through an attachment path is refused EVEN when the
    // digest is correct for the outside file — otherwise the hash check would
    // mask the confinement check and both would have to fail together.
    const outsideBytes = Buffer.from("outside-the-workspace");
    const outsidePath = join(session.workspacePath, "..", "outside-evidence.txt");
    await writeFile(outsidePath, outsideBytes);
    const outsideDigest = createHash("sha256").update(outsideBytes).digest("hex");
    await expect(engine.capabilities.execute("memory.propose", {
      kind: "semantic", title: "x", content: "y", evidenceEventIds: [],
      attachments: [{ path: "../outside-evidence.txt", mimeType: "text/plain", sha256: outsideDigest, kind: "document", confidence: 0.5 }],
    }, {
      tenantId: "t", sessionId: session.sessionId, familyId: session.sessionId, turnId: "turn",
      toolCallId: "tc3", source: "api", workspacePath: session.workspacePath, idempotencyKey: "nq-3",
    })).rejects.toThrow(/escapes the workspace/);

    // Store-level validation: a malformed digest never lands.
    await expect(engine.memory.create({
      tenantId: "t", sessionId: session.sessionId, kind: "semantic", scope: "session",
      title: "t", content: "c", evidenceEventIds: [], provenance: { createdBy: "user" }, status: "candidate",
      attachments: [{ path: "evidence.png", mimeType: "image/png", sha256: "not-a-hash", bytes: 3, kind: "image", confidence: 0.8 }],
    })).rejects.toThrow(/sha256/);
    await engine.shutdown();
  });
});

// ═══ Q3: component-level health ═══

describe("Q3 — health model", () => {
  it("reports degraded when a component fails and unknown when it cannot know", async () => {
    const service = new HealthService({
      modelProviders: () => [{ id: "mock" }],
      pingDatabase: async () => { throw new Error("ECONNREFUSED"); },
      persistenceMode: "postgres",
      natsConfigured: false,
      activeScheduledJobs: async () => 2,
      memoryHealth: async () => ({ total: 10, stale: [] }),
      cognitiveHealth: async () => ({ mode: "focus", totals: { objects: 3 } }),
    });
    const report = await service.report("t");
    expect(report.status).toBe("degraded");
    const byName = new Map(report.components.map((component) => [component.name, component]));
    expect(byName.get("persistence")?.status).toBe("degraded");
    expect(byName.get("persistence")?.detail).toContain("ECONNREFUSED");
    // A provider without status() is unknown, not healthy.
    expect(byName.get("model-providers")?.status).toBe("unknown");
    expect(byName.get("nats")?.status).toBe("unknown");
    expect(byName.get("scheduler")?.status).toBe("ok");
    expect(byName.get("memory")?.status).toBe("ok");
    expect(byName.get("cognitive")?.status).toBe("ok");
  });

  it("is ok when every reachable component answers, and reports no providers as degraded", async () => {
    const healthy = new HealthService({
      modelProviders: () => [{ id: "a", detail: { status: "healthy" } }, { id: "b", detail: { status: "healthy" } }],
      persistenceMode: "file",
      natsConfigured: true,
      activeScheduledJobs: async () => 0,
      memoryHealth: async () => ({ total: 0 }),
      cognitiveHealth: async () => ({ mode: "focus" }),
    });
    expect((await healthy.report()).status).toBe("ok");

    const providerless = new HealthService({
      modelProviders: () => [],
      persistenceMode: "file",
      natsConfigured: false,
      activeScheduledJobs: async () => 0,
      memoryHealth: async () => ({ total: 0 }),
      cognitiveHealth: async () => ({ mode: "focus" }),
    });
    const report = await providerless.report();
    expect(report.status).toBe("degraded");
    expect(report.components.find((component) => component.name === "model-providers")?.detail).toContain("No model provider");
  });

  it("answers from a live engine with the same honesty", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "nq-health-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      autoApproveWorkspaceWrites: true,
      model: { provider: "mock" },
    });
    const report = await engine.health.report();
    expect(["ok", "degraded"]).toContain(report.status);
    const byName = new Map(report.components.map((component) => [component.name, component]));
    // File mode is reported as file mode — never as a passed database check.
    expect(byName.get("persistence")?.status).toBe("unknown");
    expect(byName.get("persistence")?.detail).toContain("File-based");
    expect(byName.get("scheduler")?.status).toBe("ok");
    await engine.shutdown();
  });
});

// ═══ Q4: SLOs measured from the event stream ═══

describe("Q4 — SLO service", () => {
  it("measures task success, tool success and p95 model latency with sample counts", () => {
    const { store, push } = fakeEventStore();
    const service = new SloService(store, { taskSuccessRate: 0.5, p95ModelLatencyMs: 1000 });
    push("task.completed", { status: "succeeded" });
    push("task.completed", { status: "succeeded" });
    push("task.failed", { status: "failed" });
    push("capability.finished", { status: "ok" });
    push("capability.finished", { status: "error" });
    push("model.request.started", { iteration: 1 }, envelopeTimestamp(0), "turn-1");
    push("model.request.finished", { iteration: 1 }, envelopeTimestamp(600), "turn-1");
    push("model.request.started", { iteration: 2 }, envelopeTimestamp(0), "turn-2");
    push("model.request.finished", { iteration: 2 }, envelopeTimestamp(1200), "turn-2");

    const report = service.report();
    const byName = new Map(report.indicators.map((indicator) => [indicator.name, indicator]));
    const task = byName.get("task_success_rate")!;
    expect(task.value).toBeCloseTo(2 / 3);
    expect(task.sampleCount).toBe(3);
    expect(task.target).toBe(0.5);
    expect(task.errorBudgetRemaining).toBeGreaterThan(0);

    const tools = byName.get("tool_success_rate")!;
    expect(tools.value).toBe(0.5);
    expect(tools.sampleCount).toBe(2);

    const p95 = byName.get("p95_model_turn_latency")!;
    expect(p95.value).toBe(1200);
    expect(p95.sampleCount).toBe(2);
    expect(p95.errorBudgetRemaining).toBeLessThan(0); // over budget

    // Honest not-measured labels, never guesses.
    const recovery = byName.get("recovery_success_rate")!;
    expect(recovery.value).toBeNull();
    expect(recovery.notMeasuredReason).toBeTruthy();
    const memoryQuality = byName.get("memory_retrieval_quality")!;
    expect(memoryQuality.value).toBeNull();
    service.dispose();
  });

  it("reports null with a reason when nothing has been observed yet", () => {
    const { store } = fakeEventStore();
    const service = new SloService(store);
    const report = service.report();
    for (const name of ["task_success_rate", "tool_success_rate", "p95_model_turn_latency"]) {
      const indicator = report.indicators.find((item) => item.name === name)!;
      expect(indicator.value).toBeNull();
      expect(indicator.sampleCount).toBe(0);
      expect(indicator.notMeasuredReason).toBeTruthy();
    }
    service.dispose();
  });
});

// ═══ Q11: "Why did Aurora do this?" ═══

describe("Q11 — task explanation", () => {
  it("assembles the answer strictly from measured report fields", () => {
    const report = {
      taskId: "task-1",
      tenantId: "t",
      status: "succeeded",
      goal: "Fix the failing login test",
      userId: "u",
      attempts: 2,
      failures: [
        {
          classification: { kind: "tool_error", confidence: 0.9, signals: [], rationale: "sandbox" },
          recovery: { strategy: "retry_with_backoff", rationale: "transient", canContinue: true, backoffMs: 100 },
        },
      ],
      gaps: [],
      outcomes: [{ status: "executed", evidence: "patch applied" }],
      capabilitiesInvoked: ["filesystem.patch", "process.exec"],
      plan: { steps: [{ id: "1", description: "Reproduce the failure" }, { id: "2", description: "Patch the guard" }] },
      verification: { verdict: "pass", results: [], strongestTier: "test", autonomy: "high", status: "executed", summary: "suite green" },
      observations: [{ at: "2026-01-01T00:00:00Z", source: "routing", summary: "Model mock selected for task type \"coding\" (confidence 0.90)" }],
      spend: {}, durationMs: 100, trace: [], summary: "done",
      understanding: {
        goal: "Fix the failing login test", constraints: [], preferences: [], risks: [], successCriteria: ["suite passes"],
        missingInformation: [], ambiguity: 0, clarifyingQuestions: [], recommendation: "act", source: "model",
      },
    } as unknown as TaskReport;

    const explanation = explainTask(report);
    expect(explanation.question).toBe("Why did Aurora do this?");
    const text = explanation.answer.join(" ");
    expect(text).toContain("Fix the failing login test");
    expect(text).toContain("2-step plan");
    expect(text).toContain("Reproduce the failure");
    expect(text).toContain("Model mock selected");
    expect(text).toContain("filesystem.patch");
    expect(text).toContain("retry_with_backoff");
    expect(text).toContain("verdict: pass");
    expect(text).toContain("source: model");
    expect(explanation.facts.selectedModel).toContain("mock selected");
  });

  it("says 'not recorded' instead of inventing a model or verifier", () => {
    const report = {
      taskId: "task-2", tenantId: "t", status: "unverified", goal: "Summarize the log", attempts: 1,
      failures: [], gaps: [], outcomes: [], capabilitiesInvoked: [],
      verification: undefined, observations: [], spend: {}, durationMs: 5, trace: [], summary: "",
    } as unknown as TaskReport;
    const explanation = explainTask(report);
    const text = explanation.answer.join(" ");
    expect(text).toContain("not recorded");
    expect(text).toContain("unverified by construction");
    expect(text).toContain("without tool work");
    expect(text).toContain("No goal-understanding pass ran");
  });
});
