import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { MemoryStore } from "../memory/memory-store.js";
import { defineCapability } from "./schema.js";

/** Resolve a path inside the workspace, refusing anything that escapes it. */
async function confinedExistingFile(workspace: string, requested: string): Promise<string> {
  const root = await realpath(workspace);
  const target = await realpath(resolve(root, requested));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`Attachment path escapes the workspace: ${requested}`);
  return target;
}

export function memoryCapabilities(store: MemoryStore) {
  return [
    defineCapability(
      {
        id: "memory.search",
        version: "1.0.0",
        description: "Search active, tenant-scoped durable memories.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ query: z.string(), limit: z.number().int().positive().max(20).optional() }),
      async ({ query, limit }, context) => ({
        memories: await store.search(context.tenantId, query, { sessionId: context.sessionId, ...(limit ? { limit } : {}) }),
      }),
    ),
    defineCapability(
      {
        id: "memory.propose",
        version: "1.0.0",
        description: "Create a session-scoped memory candidate with evidence; it is not globally active until promoted.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        kind: z.enum(["episodic", "semantic", "preference", "decision"]),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(5000),
        evidenceEventIds: z.array(z.string()).max(50).default([]),
        /** P2.23: media evidence for this memory. The file's real sha256 must match, or the write is refused. */
        attachments: z.array(z.object({
          path: z.string().min(1).max(1000),
          mimeType: z.string().min(3).max(100),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          kind: z.enum(["image", "audio", "video", "document"]),
          confidence: z.number().min(0).max(1),
        })).max(10).optional(),
      }),
      async ({ kind, title, content, evidenceEventIds, attachments }, context) => {
        // P2.23: an attachment is only as good as the file it points at. The
        // claimed hash is checked against the file inside THIS workspace
        // before anything is stored — a record that references swapped or
        // non-existent evidence never lands.
        const verified: Array<{ path: string; mimeType: string; sha256: string; bytes: number; kind: "image" | "audio" | "video" | "document"; confidence: number }> = [];
        for (const attachment of attachments ?? []) {
          const absolute = await confinedExistingFile(context.workspacePath, attachment.path);
          const data = await readFile(absolute);
          const actual = createHash("sha256").update(data).digest("hex");
          if (actual !== attachment.sha256) {
            throw new Error(`Attachment ${attachment.path} content hash mismatch: claimed ${attachment.sha256.slice(0, 12)}…, measured ${actual.slice(0, 12)}… — the memory was not created.`);
          }
          verified.push({ ...attachment, bytes: data.length });
        }
        return await store.create({
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          kind,
          scope: "session",
          title,
          content,
          evidenceEventIds,
          ...(verified.length ? { attachments: verified } : {}),
          provenance: { createdBy: "agent" },
          status: "candidate",
        });
      },
    ),
  ];
}
