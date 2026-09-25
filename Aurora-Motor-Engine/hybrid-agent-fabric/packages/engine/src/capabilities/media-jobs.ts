import { z } from "zod";
import type { MediaJobManager } from "../media/media-job-manager.js";
import { defineCapability } from "./schema.js";

export function mediaJobCapabilities(jobs: MediaJobManager) {
  return [
    defineCapability(
      {
        id: "video.job.submit", version: "1.0.0",
        description: "Submit a durable asynchronous video generation job. A timed-out submission is recorded as uncertain and is never automatically replayed.",
        risk: "external_side_effect", sideEffect: true, source: "core",
      },
      z.object({
        providerId: z.string().min(1), prompt: z.string().min(1).max(20_000),
        aspectRatio: z.enum(["landscape", "square", "portrait"]).default("landscape"),
        durationSeconds: z.number().int().min(1).max(30).optional(),
        sourcePath: z.string().min(1).optional(), sourcePaths: z.array(z.string().min(1)).max(4).optional(),
      }),
      async ({ providerId, prompt, aspectRatio, durationSeconds, sourcePath, sourcePaths }, context) => await jobs.submitVideo({
        tenantId: context.tenantId, sessionId: context.sessionId, workspacePath: context.workspacePath,
        providerId, prompt, aspectRatio,
        ...(durationSeconds ? { durationSeconds } : {}), ...(sourcePath ? { sourcePath } : {}),
        ...(sourcePaths?.length ? { sourcePaths } : {}), idempotencyKey: context.idempotencyKey,
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    ),
    defineCapability(
      {
        id: "video.job.status", version: "1.0.0",
        description: "Poll a tenant-owned asynchronous video job and materialize its validated artifact when complete.",
        risk: "network", sideEffect: true, source: "core",
      },
      z.object({ id: z.string().uuid() }),
      async ({ id }, context) => await jobs.poll({ id, tenantId: context.tenantId, workspacePath: context.workspacePath, ...(context.signal ? { signal: context.signal } : {}) }),
    ),
    defineCapability(
      {
        id: "video.job.cancel", version: "1.0.0",
        description: "Cancel a confirmed external asynchronous video job. An ambiguous cancellation becomes uncertain and is not retried automatically.",
        risk: "external_side_effect", sideEffect: true, source: "core",
      },
      z.object({ id: z.string().uuid() }),
      async ({ id }, context) => await jobs.cancel({ id, tenantId: context.tenantId, ...(context.signal ? { signal: context.signal } : {}) }),
    ),
    defineCapability(
      {
        id: "video.job.list", version: "1.0.0",
        description: "List content-free asynchronous media job state for the current session.",
        risk: "workspace_read", sideEffect: false, source: "core",
      },
      z.object({}),
      async (_input, context) => ({ jobs: await jobs.list(context.tenantId, context.sessionId) }),
    ),
  ];
}
