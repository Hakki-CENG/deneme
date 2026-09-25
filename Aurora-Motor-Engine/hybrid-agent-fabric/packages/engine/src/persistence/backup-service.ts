import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { atomicWrite } from "../util/atomic-file.js";

/**
 * P2.34 backup/restore for the durable JSON state.
 *
 * Scope, stated honestly: this backs up and restores the engine's durable
 * JSON state tree (sessions, memory, research, ledgers, journals — everything
 * under the data root). Point-in-time restore means "restore to any backup in
 * the chain", each backup being a consistent snapshot at a moment. It does
 * NOT cover the PostgreSQL event store — replay-based PITR there belongs to
 * the database itself (`events` + `snapshots` tables), and claiming it here
 * would be false.
 *
 * Fail-closed rule: restore verifies every file's checksum against the
 * manifest first and refuses to touch the live tree if anything mismatches.
 * A restore that proceeded on a corrupt backup would destroy the very state
 * it was supposed to save.
 */

export interface BackupFileEntry {
  relativePath: string;
  sha256: string;
  bytes: number;
  /** Incremental only: false when the file is inherited from the base chain unchanged. */
  stored: boolean;
}

export interface BackupManifest {
  id: string;
  kind: "full" | "incremental";
  createdAt: string;
  /** Incremental only: the backup this one is based on. */
  baseBackupId?: string;
  files: BackupFileEntry[];
  fileCount: number;
  totalBytes: number;
  /** Files skipped because they are not regular files (symlinks etc.), named honestly. */
  skipped: Array<{ relativePath: string; reason: string }>;
}

export interface RestoreReport {
  backupId: string;
  verified: boolean;
  mismatches: Array<{ relativePath: string; reason: string }>;
  restoredFiles: number;
}

const MANIFEST_NAME = "backup-manifest.json";

function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function walk(root: string, current: string, files: Array<{ absolutePath: string; relativePath: string }>, skipped: BackupManifest["skipped"]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, files, skipped);
      continue;
    }
    if (!entry.isFile()) {
      skipped.push({ relativePath: relative(root, absolute), reason: `not a regular file (${entry.isSymbolicLink() ? "symlink" : "other"})` });
      continue;
    }
    files.push({ absolutePath: absolute, relativePath: relative(root, absolute) });
  }
}

export class BackupService {
  constructor(
    private readonly sourceRoot: string,
    private readonly backupRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private backupDir(id: string): string {
    return join(this.backupRoot, id);
  }

  async list(): Promise<BackupManifest[]> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.backupRoot);
    } catch {
      return [];
    }
    const manifests: BackupManifest[] = [];
    for (const entry of entries.sort()) {
      try {
        const manifest = JSON.parse(await readFile(join(this.backupRoot, entry, MANIFEST_NAME), "utf8")) as BackupManifest;
        if (manifest && manifest.id === entry) manifests.push(manifest);
      } catch {
        // A directory without a readable manifest is not a backup; skip it
        // rather than guessing what it contains.
      }
    }
    return manifests;
  }

  private async latest(): Promise<BackupManifest | undefined> {
    const all = await this.list();
    return all[all.length - 1];
  }

  /** Files recorded by a backup chain: base full backup, then incrementals. */
  private async chainFiles(backupId: string): Promise<Map<string, { sha256: string; source: string }>> {
    const map = new Map<string, { sha256: string; source: string }>();
    const chain: BackupManifest[] = [];
    let cursor: BackupManifest | undefined;
    try {
      cursor = JSON.parse(await readFile(join(this.backupDir(backupId), MANIFEST_NAME), "utf8")) as BackupManifest;
    } catch {
      throw new Error(`Backup ${backupId} not found or its manifest is unreadable.`);
    }
    while (cursor) {
      chain.unshift(cursor);
      if (!cursor.baseBackupId) break;
      const base = await this.list().then((all) => all.find((item) => item.id === cursor!.baseBackupId));
      cursor = base;
    }
    for (const manifest of chain) {
      for (const file of manifest.files) {
        // An incremental lists the WHOLE tree, but inherited files
        // (`stored: false`) live in the backup that actually stored them.
        // Recording the incremental as their source would point verify and
        // restore at a copy that does not exist there — found by the test
        // that restored an incremental chain.
        if (manifest.kind === "incremental" && !file.stored) continue;
        map.set(file.relativePath, { sha256: file.sha256, source: manifest.id });
      }
    }
    return map;
  }

  async createFull(): Promise<BackupManifest> {
    const id = `full-${this.now().toISOString().replace(/[:.]/g, "-")}`;
    const dir = this.backupDir(id);
    await mkdir(dir, { recursive: true });
    const files: Array<{ absolutePath: string; relativePath: string }> = [];
    const skipped: BackupManifest["skipped"] = [];
    await walk(this.sourceRoot, this.sourceRoot, files, skipped);
    const entries: BackupFileEntry[] = [];
    let totalBytes = 0;
    for (const file of files) {
      const content = await readFile(file.absolutePath);
      const target = join(dir, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file.absolutePath, target);
      entries.push({ relativePath: file.relativePath, sha256: sha256Of(content), bytes: content.length, stored: true });
      totalBytes += content.length;
    }
    const manifest: BackupManifest = {
      id,
      kind: "full",
      createdAt: this.now().toISOString(),
      files: entries,
      fileCount: entries.length,
      totalBytes,
      skipped,
    };
    await atomicWrite(join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  /**
   * Incremental against the latest backup: only files whose content hash
   * differs from the chain are copied. The manifest still lists the complete
   * tree (inherited files marked `stored: false`), so restore has one place
   * to look and verification covers the whole chain.
   */
  async createIncremental(): Promise<BackupManifest> {
    const base = await this.latest();
    if (!base) return await this.createFull();
    const chain = await this.chainFiles(base.id);
    const id = `incr-${this.now().toISOString().replace(/[:.]/g, "-")}`;
    const dir = this.backupDir(id);
    await mkdir(dir, { recursive: true });
    const files: Array<{ absolutePath: string; relativePath: string }> = [];
    const skipped: BackupManifest["skipped"] = [];
    await walk(this.sourceRoot, this.sourceRoot, files, skipped);
    const entries: BackupFileEntry[] = [];
    let totalBytes = 0;
    for (const file of files) {
      const content = await readFile(file.absolutePath);
      const hash = sha256Of(content);
      const known = chain.get(file.relativePath);
      if (known && known.sha256 === hash) {
        entries.push({ relativePath: file.relativePath, sha256: hash, bytes: content.length, stored: false });
        continue;
      }
      const target = join(dir, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file.absolutePath, target);
      entries.push({ relativePath: file.relativePath, sha256: hash, bytes: content.length, stored: true });
      totalBytes += content.length;
    }
    const manifest: BackupManifest = {
      id,
      kind: "incremental",
      createdAt: this.now().toISOString(),
      baseBackupId: base.id,
      files: entries,
      fileCount: entries.length,
      totalBytes,
      skipped,
    };
    await atomicWrite(join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  /**
   * Verification re-hashes every stored file in the chain and compares with
   * the manifest. Inherited (non-stored) files are checked in the backup that
   * actually stores them.
   */
  async verify(backupId: string): Promise<{ verified: boolean; mismatches: Array<{ relativePath: string; reason: string }> }> {
    const chain = await this.chainFiles(backupId);
    const manifests = await this.list();
    const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
    const mismatches: Array<{ relativePath: string; reason: string }> = [];
    for (const [relativePath, info] of chain) {
      const owner = byId.get(info.source);
      const entry = owner?.files.find((file) => file.relativePath === relativePath && file.stored);
      if (!entry) {
        mismatches.push({ relativePath, reason: `no stored copy in chain (claimed source backup ${info.source})` });
        continue;
      }
      const stored = join(this.backupDir(info.source), relativePath);
      let content: Buffer;
      try {
        const stats = await stat(stored);
        if (!stats.isFile()) throw new Error("not a regular file");
        content = await readFile(stored);
      } catch {
        mismatches.push({ relativePath, reason: `stored copy missing or unreadable in ${info.source}` });
        continue;
      }
      if (sha256Of(content) !== info.sha256) {
        mismatches.push({ relativePath, reason: `checksum mismatch in ${info.source}` });
      }
    }
    return { verified: mismatches.length === 0, mismatches };
  }

  /**
   * Restore a chain into the live tree. Verification runs first and a single
   * mismatch aborts the whole restore — no partial restores, ever.
   */
  async restore(backupId: string): Promise<RestoreReport> {
    const { verified, mismatches } = await this.verify(backupId);
    if (!verified) {
      return { backupId, verified: false, mismatches, restoredFiles: 0 };
    }
    const chain = await this.chainFiles(backupId);
    const manifests = await this.list();
    const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
    let restored = 0;
    for (const [relativePath, info] of chain) {
      const owner = byId.get(info.source);
      const entry = owner?.files.find((file) => file.relativePath === relativePath && file.stored);
      if (!entry) continue;
      const source = join(this.backupDir(info.source), relativePath);
      const target = resolve(this.sourceRoot, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(source));
      restored++;
    }
    return { backupId, verified: true, mismatches: [], restoredFiles: restored };
  }
}
