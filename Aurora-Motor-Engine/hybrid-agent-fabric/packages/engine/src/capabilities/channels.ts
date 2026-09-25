import { readFile, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ChannelAdapterRegistry, OutboundMedia } from "../channels/delivery-adapters.js";
import { defineCapability } from "./schema.js";

function detectMime(path: string, bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(Buffer.from(bytes.slice(0, 6)).toString())) return "image/gif";
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString() === "RIFF" && Buffer.from(bytes.slice(8, 12)).toString() === "WEBP") return "image/webp";
  if (bytes.length >= 12 && Buffer.from(bytes.slice(4, 8)).toString() === "ftyp") return path.toLowerCase().endsWith(".m4a") ? "audio/mp4" : "video/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString() === "RIFF" && Buffer.from(bytes.slice(8, 12)).toString() === "WAVE") return "audio/wav";
  if (bytes.length >= 4 && Buffer.from(bytes.slice(0, 4)).toString() === "OggS") return "audio/ogg";
  if (bytes.length >= 3 && (Buffer.from(bytes.slice(0, 3)).toString() === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))) return "audio/mpeg";
  if (bytes.length >= 4 && Buffer.from(bytes.slice(0, 4)).toString() === "%PDF") return "application/pdf";
  return undefined;
}

async function loadMedia(workspacePath: string, requested: string): Promise<OutboundMedia> {
  const root = await realpath(workspacePath);
  const target = await realpath(resolve(root, requested));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Channel media path escapes the workspace.");
  const data = await readFile(target);
  if (!data.length || data.length > 25 * 1024 * 1024) throw new Error("Channel media exceeds the 25 MiB limit.");
  const mimeType = detectMime(target, data);
  if (!mimeType) throw new Error("Channel media type is unsupported or does not match known magic bytes.");
  return { fileName: basename(target).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 200) || "attachment.bin", mimeType, data };
}

export function channelCapabilities(registry: ChannelAdapterRegistry) {
  return [
    defineCapability(
      {
        id: "channel.send",
        version: "1.0.0",
        description: "Send text and an optional bounded workspace media artifact through a configured outbound channel adapter. This creates an external side effect.",
        risk: "external_side_effect",
        sideEffect: true,
        source: "core",
      },
      z.object({
        platform: z.string().min(1),
        destination: z.string().min(1),
        text: z.string().min(1).max(100_000),
        threadId: z.string().optional(),
        mediaPath: z.string().min(1).optional(),
      }),
      async ({ platform, destination, text, threadId, mediaPath }, context) => {
        const media = mediaPath ? await loadMedia(context.workspacePath, mediaPath) : undefined;
        return await registry.send(
          platform,
          { destination, text, ...(threadId ? { threadId } : {}), ...(media ? { media } : {}) },
          context.signal,
        );
      },
    ),
  ];
}
