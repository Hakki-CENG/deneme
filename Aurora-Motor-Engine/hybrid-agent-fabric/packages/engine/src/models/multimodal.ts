import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ImageContent } from "../types.js";

export interface ResolvedWorkspaceImage {
  bytes: Uint8Array;
  base64: string;
  mimeType: ImageContent["mimeType"];
  sha256: string;
}

function detectedMime(bytes: Uint8Array): ImageContent["mimeType"] | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString() === "RIFF" && Buffer.from(bytes.slice(8, 12)).toString() === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(Buffer.from(bytes.slice(0, 6)).toString())) return "image/gif";
  return undefined;
}

export async function resolveWorkspaceImage(part: ImageContent, workspacePath?: string, maxBytes = 10 * 1024 * 1024): Promise<ResolvedWorkspaceImage> {
  if (!workspacePath) throw new Error("Multimodal image resolution requires a workspace path.");
  const root = await realpath(workspacePath);
  const target = await realpath(resolve(root, part.path));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Multimodal image path escapes the workspace.");
  const bytes = await readFile(target);
  if (!bytes.length || bytes.length > maxBytes) throw new Error("Multimodal image exceeds the configured byte limit.");
  const mimeType = detectedMime(bytes);
  if (!mimeType || mimeType !== part.mimeType) throw new Error("Multimodal image MIME type does not match its raster content.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (part.sha256 && part.sha256.toLowerCase() !== sha256) throw new Error("Multimodal image SHA-256 verification failed.");
  return { bytes, base64: bytes.toString("base64"), mimeType, sha256 };
}
