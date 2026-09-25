import { z } from "zod";
import type { VideoGenerationService } from "../media/video-generation.js";
import { defineCapability } from "./schema.js";

export function videoCapability(video: VideoGenerationService) {
  return defineCapability(
    {
      id: "video.generate",
      version: "1.1.0",
      description: "Generate text-to-video or video from up to 4 confined reference images through the configured provider and materialize a bounded MP4/WebM workspace artifact.",
      risk: "network",
      sideEffect: true,
      source: "core",
    },
    z.object({
      prompt: z.string().min(1).max(20_000),
      aspectRatio: z.enum(["landscape", "square", "portrait"]).default("landscape"),
      durationSeconds: z.number().int().min(1).max(30).optional(),
      sourcePath: z.string().min(1).optional(),
      sourcePaths: z.array(z.string().min(1)).max(4).optional(),
      providerId: z.string().optional(),
    }),
    async ({ prompt, aspectRatio, durationSeconds, sourcePath, sourcePaths, providerId }, context) => await video.generate({
      workspacePath: context.workspacePath,
      prompt,
      aspectRatio,
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(sourcePaths?.length ? { sourcePaths } : {}),
      ...(providerId ? { providerId } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    }),
  );
}

export function videoUpscaleCapability(video: VideoGenerationService) {
  return defineCapability(
    {
      id: "video.upscale",
      version: "1.0.0",
      description: "Upscale one confined MP4/WebM video by 2x or 4x, verify container dimensions, and materialize a bounded workspace artifact.",
      risk: "network",
      sideEffect: true,
      source: "core",
    },
    z.object({
      sourcePath: z.string().min(1),
      providerId: z.string().min(1),
      scale: z.union([z.literal(2), z.literal(4)]),
    }),
    async ({ sourcePath, providerId, scale }, context) => await video.upscale({
      workspacePath: context.workspacePath,
      sourcePath,
      providerId,
      scale,
      ...(context.signal ? { signal: context.signal } : {}),
    }),
  );
}
