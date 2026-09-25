import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaJobManager } from "../src/media/media-job-manager.js";
import { FalQueuedVideoProvider, VideoGenerationService, type QueuedVideoGenerationProvider } from "../src/media/video-generation.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32)]);

describe("durable asynchronous media jobs", () => {
  it("uses the FAL queue submit/status/result/cancel contract without credential leakage", async () => {
    const calls: Array<{ url: string; method: string; auth: string; body: string }> = [];
    let statusCalls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input); calls.push({ url, method: String(init?.method), auth: new Headers(init?.headers).get("authorization") ?? "", body: String(init?.body ?? "") });
      if (init?.method === "POST") return Response.json({ request_id: "request_123" });
      if (url.endsWith("/status")) { statusCalls++; return Response.json({ status: statusCalls === 1 ? "IN_PROGRESS" : "COMPLETED" }); }
      if (url.endsWith("/cancel")) return new Response(null, { status: 204 });
      return Response.json({ video: { base64: mp4.toString("base64"), content_type: "video/mp4" } });
    }) as typeof fetch;
    const provider = new FalQueuedVideoProvider({ apiKey: "queue-secret", model: "fal-ai/video" });
    expect(await provider.submit({ prompt: "motion", aspectRatio: "landscape" })).toEqual({ externalJobId: "request_123", model: "fal-ai/video" });
    expect(await provider.poll("request_123")).toEqual({ status: "running" });
    expect(await provider.poll("request_123")).toMatchObject({ status: "succeeded", model: "fal-ai/video", video: { mimeType: "video/mp4" } });
    await provider.cancel("request_123");
    expect(calls.map((item) => item.url)).toEqual([
      "https://queue.fal.run/fal-ai/video",
      "https://queue.fal.run/fal-ai/video/requests/request_123/status",
      "https://queue.fal.run/fal-ai/video/requests/request_123/status",
      "https://queue.fal.run/fal-ai/video/requests/request_123",
      "https://queue.fal.run/fal-ai/video/requests/request_123/cancel",
    ]);
    expect(calls.every((item) => item.auth === "Key queue-secret")).toBe(true);
    expect(JSON.stringify(calls.map((item) => item.body))).not.toContain("queue-secret");
  });

  it("resumes polling after manager replacement, materializes output and deduplicates submission keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-media-job-"));
    let submissions = 0;
    const queued: QueuedVideoGenerationProvider = {
      id: "fake-queue",
      async submit() { submissions++; return { externalJobId: "external_1", model: "queued-model" }; },
      async poll() { return { status: "succeeded", model: "queued-model", video: { base64: mp4.toString("base64") } }; },
      async cancel() {},
    };
    const video = new VideoGenerationService(); video.registerQueued(queued);
    const first = new MediaJobManager(root, video);
    const input = { tenantId: "tenant", sessionId: "session", workspacePath: root, providerId: "fake-queue", prompt: "private prompt text", idempotencyKey: "stable-request" };
    const job = await first.submitVideo(input);
    expect(job.status).toBe("queued");
    expect(await first.submitVideo(input)).toEqual(job);
    expect(submissions).toBe(1);
    const persisted = await readFile(join(root, "media", "jobs.json"), "utf8");
    expect(persisted).not.toContain("private prompt text");
    expect(persisted).not.toContain("stable-request");
    expect(persisted).not.toContain(root);
    expect(JSON.stringify(job)).not.toContain("external_1");

    const replacement = new MediaJobManager(root, video);
    const completed = await replacement.poll({ id: job.id, tenantId: "tenant", workspacePath: root });
    expect(completed).toMatchObject({ status: "succeeded", model: "queued-model", artifact: { mimeType: "video/mp4" } });
    expect(await readFile(join(root, completed.artifact!.path))).toEqual(mp4);
  });

  it("records ambiguous submissions/cancellations as uncertain and never auto-replays them", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-media-uncertain-"));
    let submissions = 0;
    const failing: QueuedVideoGenerationProvider = {
      id: "failing",
      async submit() { submissions++; throw new Error("timeout after possible acceptance"); },
      async poll() { return { status: "queued" }; }, async cancel() { throw new Error("cancel timeout"); },
    };
    const service = new VideoGenerationService(); service.registerQueued(failing);
    const manager = new MediaJobManager(root, service);
    await expect(manager.submitVideo({ tenantId: "tenant", sessionId: "session", workspacePath: root, providerId: "failing", prompt: "x", idempotencyKey: "once" })).rejects.toThrow("possible acceptance");
    const jobs = await manager.list("tenant");
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ status: "uncertain", errorCode: "submission_uncertain" });
    const replacement = new MediaJobManager(root, service);
    expect(await replacement.submitVideo({ tenantId: "tenant", sessionId: "session", workspacePath: root, providerId: "failing", prompt: "x", idempotencyKey: "once" })).toMatchObject({ id: jobs[0]!.id, status: "uncertain" });
    expect(submissions).toBe(1);
    await expect(replacement.cancel({ id: jobs[0]!.id, tenantId: "tenant" })).rejects.toThrow("no confirmed external job id");

    const cancelRoot = await mkdtemp(join(tmpdir(), "haf-media-cancel-"));
    const cancelProvider: QueuedVideoGenerationProvider = {
      id: "cancel-failing", async submit() { return { externalJobId: "external_2", model: "m" }; },
      async poll() { return { status: "running" }; }, async cancel() { throw new Error("cancel may have succeeded"); },
    };
    const cancelService = new VideoGenerationService(); cancelService.registerQueued(cancelProvider);
    const cancelManager = new MediaJobManager(cancelRoot, cancelService);
    const cancellable = await cancelManager.submitVideo({ tenantId: "tenant", sessionId: "session", workspacePath: cancelRoot, providerId: "cancel-failing", prompt: "x" });
    await expect(cancelManager.cancel({ id: cancellable.id, tenantId: "tenant" })).rejects.toThrow("may have succeeded");
    expect(await cancelManager.get(cancellable.id, "tenant")).toMatchObject({ status: "uncertain", errorCode: "cancellation_uncertain" });
  });

  it("rejects FAL queue redirects and unsafe request identifiers", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })) as typeof fetch;
    const provider = new FalQueuedVideoProvider({ apiKey: "x", model: "fal-ai/video" });
    await expect(provider.submit({ prompt: "x", aspectRatio: "square" })).rejects.toThrow("redirects are forbidden");
    await expect(provider.poll("../escape")).rejects.toThrow("invalid request id");
  });
});
