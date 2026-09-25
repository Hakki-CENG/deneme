import { z } from "zod";
import type { AudioService } from "../audio/audio-service.js";
import { defineCapability } from "./schema.js";

export function audioCapabilities(audio: AudioService) {
  return [
    defineCapability(
      { id: "audio.transcribe", version: "1.0.0", description: "Transcribe a bounded workspace audio file through the configured STT provider.", risk: "network", sideEffect: false, source: "core" },
      z.object({ path: z.string().min(1), language: z.string().optional(), prompt: z.string().max(5000).optional() }),
      async ({ path, language, prompt }, context) => await audio.transcribe({
        workspacePath: context.workspacePath,
        path,
        ...(language ? { language } : {}),
        ...(prompt ? { prompt } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    ),
    defineCapability(
      { id: "audio.synthesize", version: "1.0.0", description: "Synthesize speech and save it as a workspace artifact.", risk: "network", sideEffect: true, source: "core" },
      z.object({
        text: z.string().min(1).max(100_000),
        outputPath: z.string().min(1),
        voice: z.string().optional(),
        format: z.enum(["mp3", "wav", "opus", "aac", "flac"]).default("mp3"),
        speed: z.number().min(0.25).max(4).default(1),
      }),
      async ({ text, outputPath, voice, format, speed }, context) => await audio.synthesize({
        workspacePath: context.workspacePath,
        text,
        outputPath,
        ...(voice ? { voice } : {}),
        format,
        speed,
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    ),
  ];
}
