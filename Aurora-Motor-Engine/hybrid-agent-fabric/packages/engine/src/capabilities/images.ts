import { z } from "zod";
import type { ImageGenerationService } from "../media/image-generation.js";
import { defineCapability } from "./schema.js";

export function imageCapabilities(images: ImageGenerationService) {
  return [
    defineCapability(
      {
        id: "image.generate",
        version: "1.1.0",
        description: "Generate or edit 1-4 raster images from text or up to 8 confined references, optionally chaining a configured upscaler, and materialize bounded workspace artifacts.",
        risk: "network",
        sideEffect: true,
        source: "core",
      },
      z.object({
        prompt: z.string().min(1).max(20_000),
        aspectRatio: z.enum(["landscape", "square", "portrait"]).default("landscape"),
        count: z.number().int().min(1).max(4).default(1),
        providerId: z.string().optional(),
        model: z.string().optional(),
        sourcePath: z.string().min(1).optional(),
        sourcePaths: z.array(z.string().min(1)).max(8).optional(),
        upscale: z.object({ providerId: z.string().min(1), scale: z.union([z.literal(2), z.literal(4)]) }).optional(),
      }),
      async ({ prompt, aspectRatio, count, providerId, model, sourcePath, sourcePaths, upscale }, context) => await images.generate({
        workspacePath: context.workspacePath,
        prompt,
        aspectRatio,
        count,
        ...(providerId ? { providerId } : {}),
        ...(model ? { model } : {}),
        ...(sourcePath ? { sourcePath } : {}),
        ...(sourcePaths?.length ? { sourcePaths } : {}),
        ...(upscale ? { upscale } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    ),
    defineCapability(
      {
        id: "image.upscale",
        version: "1.0.0",
        description: "Upscale one confined raster image by 2x or 4x through a configured provider and materialize a validated workspace artifact.",
        risk: "network",
        sideEffect: true,
        source: "core",
      },
      z.object({
        sourcePath: z.string().min(1),
        providerId: z.string().min(1),
        scale: z.union([z.literal(2), z.literal(4)]),
      }),
      async ({ sourcePath, providerId, scale }, context) => await images.upscale({
        workspacePath: context.workspacePath,
        sourcePath,
        providerId,
        scale,
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    ),
  ];
}
