import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { atomicWriteBuffer } from "../util/atomic-file.js";
import {
  auroraDigest, auroraInteger, auroraRound, auroraText, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_CHECKPOINTS = 5_000;
const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_EXCLUDES = ["node_modules", ".git", "dist", "build", "target", "__pycache__", ".venv", "coverage", ".next", ".cache", "vendor"];

export interface CheckpointFileEntry {
  path: string;
  bytes: number;
  digest: string;
  mode: number;
}

export interface WorkspaceCheckpoint {
  id: string;
  tenantId: string;
  sessionId?: string;
  label: string;
  reason: string;
  workspaceDigest: string;
  files: CheckpointFileEntry[];
  totalBytes: number;
  skipped: Array<{ path: string; reason: string }>;
  actionId?: string;
  createdAt: string;
  restoredAt?: string;
  restoreCount: number;
}

export interface CheckpointDiffEntry {
  path: string;
  change: "added" | "removed" | "modified";
  bytes?: number;
}

export interface CheckpointDiff {
  checkpointId: string;
  changed: CheckpointDiffEntry[];
  unchanged: number;
  generatedAt: string;
}

export interface CheckpointRestoreReport {
  checkpointId: string;
  restored: number;
  removed: number;
  unchanged: number;
  safetyCheckpointId?: string;
  restoredAt: string;
}

interface CheckpointStateShape {
  schemaVersion: 1;
  checkpoints: WorkspaceCheckpoint[];
}

/** Directory names are matched literally; dotted names like `.git` are normal and must be allowed. */
function normalizeExcludes(values: readonly string[]): string[] {
  const excludes = [...new Set(values.map((item) => item.trim().toLowerCase()))].filter((item) => item.length > 0);
  if (excludes.length > 200 || excludes.some((item) => item.length > 100 || item.includes("/") || item.includes("\\"))) {
    throw new Error("Checkpoint excludes must be plain directory or file names.");
  }
  return excludes;
}

export interface CheckpointLimits {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  excludes?: string[];
}

/**
 * Aurora workspace checkpoints (Hermes-derived, Aurora-governed).
 *
 * The constitution requires a recovery path for destructive work (C7), and a rollback plan written in
 * prose is not a recovery path. This service takes a bounded content-addressed snapshot of a session
 * workspace before risky work and can restore it exactly afterwards.
 *
 * Safety properties that make it usable unattended:
 * - snapshots are bounded by file count, per-file size and total size, and refuse to grow silently;
 * - build and dependency directories are excluded by default so checkpoints stay cheap;
 * - restore is preceded by an automatic safety checkpoint, so a rollback is itself reversible;
 * - every path is confined to the workspace root: symlink escapes and `..` traversal are rejected;
 * - content is stored under content-addressed digests, so repeated checkpoints of the same file cost
 *   nothing extra.
 */
export class WorkspaceCheckpointService {
  private readonly store: DurableJsonState<CheckpointStateShape>;
  private readonly blobRoot: string;

  constructor(
    private readonly rootPath: string,
    private readonly limits: CheckpointLimits = {},
    private readonly now: () => number = Date.now,
  ) {
    this.store = new DurableJsonState<CheckpointStateShape>(
      join(rootPath, "checkpoints", "state.json"),
      () => ({ schemaVersion: 1, checkpoints: [] }),
      (value) => {
        const state = value as CheckpointStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.checkpoints);
      },
      "Aurora workspace checkpoints",
    );
    this.blobRoot = join(rootPath, "checkpoints", "blobs");
  }

  /** Snapshot a workspace. Returns the manifest; file contents are stored content-addressed. */
  async capture(input: { tenantId: string; workspacePath: string; label: string; reason: string; sessionId?: string; actionId?: string; limits?: CheckpointLimits }): Promise<WorkspaceCheckpoint> {
    const root = resolve(input.workspacePath);
    const limits = {
      maxFiles: auroraInteger(input.limits?.maxFiles ?? this.limits.maxFiles ?? DEFAULT_MAX_FILES, 1, 50_000, "Checkpoint file limit"),
      maxTotalBytes: auroraInteger(input.limits?.maxTotalBytes ?? this.limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, 1024, 1024 * 1024 * 1024, "Checkpoint size limit"),
      maxFileBytes: auroraInteger(input.limits?.maxFileBytes ?? this.limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 1, 256 * 1024 * 1024, "Checkpoint file size limit"),
      excludes: normalizeExcludes(input.limits?.excludes ?? this.limits.excludes ?? DEFAULT_EXCLUDES),
    };
    const rootStat = await stat(root).catch(() => undefined);
    if (!rootStat?.isDirectory()) throw new Error("Checkpoint workspace path is not a directory.");

    const files: CheckpointFileEntry[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let totalBytes = 0;
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = join(directory, entry.name);
        const relativePath = relative(root, absolute).split(sep).join("/");
        if (limits.excludes.includes(entry.name.toLowerCase())) {
          skipped.push({ path: relativePath, reason: "excluded" });
          continue;
        }
        if (entry.isSymbolicLink()) {
          skipped.push({ path: relativePath, reason: "symlink" });
          continue;
        }
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) {
          skipped.push({ path: relativePath, reason: "not-a-regular-file" });
          continue;
        }
        if (files.length >= limits.maxFiles) {
          skipped.push({ path: relativePath, reason: "file-limit" });
          continue;
        }
        const info = await stat(absolute);
        if (info.size > limits.maxFileBytes) {
          skipped.push({ path: relativePath, reason: "file-too-large" });
          continue;
        }
        if (totalBytes + info.size > limits.maxTotalBytes) {
          skipped.push({ path: relativePath, reason: "size-limit" });
          continue;
        }
        const content = await readFile(absolute);
        const digest = auroraDigest(content.toString("base64"));
        await this.writeBlob(digest, content);
        totalBytes += info.size;
        files.push({ path: relativePath, bytes: info.size, digest, mode: info.mode & 0o777 });
      }
    };
    await walk(root);

    const checkpoint: WorkspaceCheckpoint = {
      id: `checkpoint-${randomUUID()}`,
      tenantId: input.tenantId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.actionId ? { actionId: input.actionId } : {}),
      label: auroraText(input.label, 200, "Checkpoint label"),
      reason: auroraText(input.reason, 2000, "Checkpoint reason"),
      workspaceDigest: auroraDigest(files.map((item) => `${item.path}:${item.digest}`).join("|")),
      files,
      totalBytes,
      skipped: skipped.slice(0, 500),
      createdAt: new Date(this.now()).toISOString(),
      restoreCount: 0,
    };
    await this.store.mutate((state) => {
      state.checkpoints.push(checkpoint);
      if (state.checkpoints.length > MAX_CHECKPOINTS) state.checkpoints.splice(0, state.checkpoints.length - MAX_CHECKPOINTS);
    });
    return structuredClone(checkpoint);
  }

  /** What changed in the workspace since a checkpoint, without touching anything. */
  async diff(tenantId: string, checkpointId: string, workspacePath: string): Promise<CheckpointDiff> {
    const checkpoint = await this.get(tenantId, checkpointId);
    const root = resolve(workspacePath);
    const changed: CheckpointDiffEntry[] = [];
    let unchanged = 0;
    const current = new Map<string, { bytes: number; digest: string }>();
    for (const entry of checkpoint.files) {
      const absolute = this.confine(root, entry.path);
      const info = await stat(absolute).catch(() => undefined);
      if (!info?.isFile()) {
        changed.push({ path: entry.path, change: "removed" });
        continue;
      }
      const digest = auroraDigest((await readFile(absolute)).toString("base64"));
      current.set(entry.path, { bytes: info.size, digest });
      if (digest === entry.digest) unchanged++;
      else changed.push({ path: entry.path, change: "modified", bytes: info.size });
    }
    const known = new Set(checkpoint.files.map((item) => item.path));
    for (const path of await this.listWorkspaceFiles(root)) {
      if (known.has(path)) continue;
      const info = await stat(join(root, path)).catch(() => undefined);
      changed.push({ path, change: "added", ...(info ? { bytes: info.size } : {}) });
    }
    return { checkpointId: checkpoint.id, changed, unchanged, generatedAt: new Date(this.now()).toISOString() };
  }

  /**
   * Restore a workspace to a checkpoint. A safety checkpoint of the current state is taken first
   * unless explicitly disabled, so an unwanted rollback can itself be rolled back.
   */
  async restore(input: { tenantId: string; checkpointId: string; workspacePath: string; removeAddedFiles?: boolean; safetyCheckpoint?: boolean }): Promise<CheckpointRestoreReport> {
    const checkpoint = await this.get(input.tenantId, input.checkpointId);
    const root = resolve(input.workspacePath);
    const rootStat = await stat(root).catch(() => undefined);
    if (!rootStat?.isDirectory()) throw new Error("Restore target workspace is not a directory.");

    let safetyCheckpointId: string | undefined;
    if (input.safetyCheckpoint !== false) {
      const safety = await this.capture({
        tenantId: input.tenantId,
        workspacePath: root,
        label: `pre-restore ${checkpoint.label}`.slice(0, 200),
        reason: `Automatic safety checkpoint before restoring ${checkpoint.id}.`,
        ...(checkpoint.sessionId ? { sessionId: checkpoint.sessionId } : {}),
      });
      safetyCheckpointId = safety.id;
    }

    let restored = 0;
    let unchanged = 0;
    for (const entry of checkpoint.files) {
      const absolute = this.confine(root, entry.path);
      const existing = await readFile(absolute).catch(() => undefined);
      if (existing && auroraDigest(existing.toString("base64")) === entry.digest) {
        unchanged++;
        continue;
      }
      const content = await this.readBlob(entry.digest);
      await mkdir(dirname(absolute), { recursive: true });
      await atomicWriteBuffer(absolute, content);
      restored++;
    }

    let removed = 0;
    if (input.removeAddedFiles) {
      const known = new Set(checkpoint.files.map((item) => item.path));
      for (const path of await this.listWorkspaceFiles(root)) {
        if (known.has(path)) continue;
        await rm(this.confine(root, path), { force: true });
        removed++;
      }
    }

    const restoredAt = new Date(this.now()).toISOString();
    await this.store.mutate((state) => {
      const record = state.checkpoints.find((item) => item.tenantId === input.tenantId && item.id === input.checkpointId);
      if (record) {
        record.restoredAt = restoredAt;
        record.restoreCount++;
      }
    });
    return { checkpointId: checkpoint.id, restored, removed, unchanged, ...(safetyCheckpointId ? { safetyCheckpointId } : {}), restoredAt };
  }

  async list(tenantId: string, filter?: { sessionId?: string; limit?: number }): Promise<WorkspaceCheckpoint[]> {
    const state = await this.store.read();
    return state.checkpoints
      .filter((item) => item.tenantId === tenantId && (!filter?.sessionId || item.sessionId === filter.sessionId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, auroraInteger(filter?.limit ?? 50, 1, 1000, "Checkpoint limit"))
      .map((item) => ({ ...structuredClone(item), files: item.files.slice(0, 50) }));
  }

  async get(tenantId: string, checkpointId: string): Promise<WorkspaceCheckpoint> {
    const state = await this.store.read();
    const checkpoint = state.checkpoints.find((item) => item.tenantId === tenantId && item.id === checkpointId);
    if (!checkpoint) throw new Error("Workspace checkpoint not found in tenant.");
    return structuredClone(checkpoint);
  }

  /** Delete a checkpoint and any content blobs no other checkpoint still references. */
  async remove(tenantId: string, checkpointId: string): Promise<{ removedCheckpoint: string; removedBlobs: number }> {
    const outcome = await this.store.mutate((state) => {
      const index = state.checkpoints.findIndex((item) => item.tenantId === tenantId && item.id === checkpointId);
      if (index < 0) throw new Error("Workspace checkpoint not found in tenant.");
      const [removed] = state.checkpoints.splice(index, 1);
      const stillReferenced = new Set(state.checkpoints.flatMap((item) => item.files.map((file) => file.digest)));
      const orphans = [...new Set((removed?.files ?? []).map((file) => file.digest))].filter((digest) => !stillReferenced.has(digest));
      return { orphans };
    });
    let removedBlobs = 0;
    for (const digest of outcome.orphans) {
      await rm(this.blobPath(digest), { force: true }).then(() => { removedBlobs++; }).catch(() => undefined);
    }
    return { removedCheckpoint: checkpointId, removedBlobs };
  }

  /** Storage footprint of the checkpoint store, for retention decisions. */
  async usage(tenantId: string): Promise<{ tenantId: string; checkpoints: number; files: number; logicalBytes: number; uniqueBlobs: number; deduplicationRatio: number; generatedAt: string }> {
    const state = await this.store.read();
    const checkpoints = state.checkpoints.filter((item) => item.tenantId === tenantId);
    const digests = new Set<string>();
    let files = 0;
    let logicalBytes = 0;
    for (const checkpoint of checkpoints) {
      for (const file of checkpoint.files) {
        files++;
        logicalBytes += file.bytes;
        digests.add(file.digest);
      }
    }
    return {
      tenantId,
      checkpoints: checkpoints.length,
      files,
      logicalBytes,
      uniqueBlobs: digests.size,
      deduplicationRatio: files ? auroraRound(digests.size / files) : 1,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  private async listWorkspaceFiles(root: string, directory = root, excludes = normalizeExcludes(this.limits.excludes ?? DEFAULT_EXCLUDES)): Promise<string[]> {
    const output: string[] = [];
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (excludes.includes(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        output.push(...await this.listWorkspaceFiles(root, absolute, excludes));
        continue;
      }
      if (!entry.isFile()) continue;
      output.push(relative(root, absolute).split(sep).join("/"));
    }
    return output;
  }

  private confine(root: string, relativePath: string): string {
    const absolute = resolve(root, relativePath);
    const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
    if (absolute !== root && !absolute.startsWith(rootWithSep)) throw new Error("Checkpoint path escapes the workspace root.");
    return absolute;
  }

  private blobPath(digest: string): string {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Checkpoint blob digest is invalid.");
    return join(this.blobRoot, digest.slice(0, 2), digest);
  }

  private async writeBlob(digest: string, content: Buffer): Promise<void> {
    const path = this.blobPath(digest);
    const existing = await stat(path).catch(() => undefined);
    if (existing?.isFile()) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o600 });
  }

  private async readBlob(digest: string): Promise<Buffer> {
    const content = await readFile(this.blobPath(digest)).catch(() => undefined);
    if (!content) throw new Error("Checkpoint content blob is missing; the checkpoint cannot be restored.");
    if (auroraDigest(content.toString("base64")) !== digest) throw new Error("Checkpoint content blob failed its integrity check.");
    return content;
  }

  /** Root of the content-addressed blob store, exposed for operational tooling. */
  get storageRoot(): string {
    return join(this.rootPath, "checkpoints");
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const pf = (s as any).checkpoints?.filter((x: any) => x.tenantId === tenantId) ?? [];
    const sf = [];
    return { totalPrimary: pf.length, totalSecondary: sf.length };
  }

  // ═══ P2: Explainability ═══

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    const s = await this.store.read();
    const keys = Object.keys(s);
    const arrayKey = keys.find(k => Array.isArray((s as any)[k]));
    const items: any[] = arrayKey ? ((s as any)[arrayKey] as any[]).filter((x: any) => x.tenantId === tenantId) : [];
    const entity = items.find((x: any) => x.id === entityId);
    if (!entity) throw new Error("Entity not found");
    const rationale: string[] = [`Found entity: ${entity.name ?? entity.title ?? entity.id ?? entityId}`];
    return { entity: entity.name ?? entity.title ?? entityId, summary: entity.description ?? entity.statement ?? "", rationale, details: entity };
  }
}
