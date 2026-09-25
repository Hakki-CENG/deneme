import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * P1.34 workspace quotas.
 *
 * A workspace that can grow without bound is a denial-of-service waiting for
 * an agent that writes a 2 GB log "just in case". The quota is enforced on
 * the write path (filesystem.write / write_binary / patch / archive extract)
 * by projecting the workspace's current usage plus the write's delta against
 * the configured ceiling.
 *
 * Usage is measured by a bounded recursive scan and cached briefly, then
 * tracked by deltas between scans, so a burst of writes does not rescan the
 * tree each time. The measurement is honest about its own limits: when the
 * scan hits its file ceiling it reports `capped: true` rather than pretending
 * it counted everything.
 */
export class WorkspaceQuota {
  private readonly cache = new Map<string, { bytes: number; capped: boolean; at: number }>();
  private readonly deltas = new Map<string, number>();

  constructor(
    /** Maximum total bytes the workspace may hold. */
    readonly quotaBytes: number,
    private readonly scanTtlMs = 30_000,
    private readonly maxFiles = 25_000,
  ) {}

  async usage(root: string): Promise<{ bytes: number; capped: boolean }> {
    const cached = this.cache.get(root);
    if (cached && Date.now() - cached.at < this.scanTtlMs) {
      return { bytes: Math.max(0, cached.bytes + (this.deltas.get(root) ?? 0)), capped: cached.capped };
    }
    let bytes = 0;
    let files = 0;
    let capped = false;
    const walk = async (directory: string): Promise<void> => {
      if (files >= this.maxFiles) {
        capped = true;
        return;
      }
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (files >= this.maxFiles) {
          capped = true;
          return;
        }
        const full = join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          files += 1;
          bytes += (await stat(full).catch(() => undefined))?.size ?? 0;
        }
      }
    };
    await walk(root);
    this.cache.set(root, { bytes, capped, at: Date.now() });
    this.deltas.set(root, 0);
    return { bytes, capped };
  }

  /**
   * Record a completed write's size delta so the cached projection stays
   * truthful between scans. Negative deltas (shrinking writes, deletes) are
   * fine.
   */
  recordDelta(root: string, deltaBytes: number): void {
    this.deltas.set(root, (this.deltas.get(root) ?? 0) + deltaBytes);
  }

  /**
   * Refuse a write whose projected total would exceed the quota. The refusal
   * names both numbers so an operator can tell whether the quota is too small
   * or the write is too large.
   */
  async assertCanWrite(root: string, pathBytesNow: number, pathBytesAfter: number, label: string): Promise<void> {
    const { bytes, capped } = await this.usage(root);
    const projected = Math.max(0, bytes - pathBytesNow) + pathBytesAfter;
    if (projected > this.quotaBytes) {
      throw new Error(
        `Workspace quota exceeded for ${label}: projected ${(projected / 1024 / 1024).toFixed(2)} MiB (current ${(Math.max(0, bytes - pathBytesNow) / 1024 / 1024).toFixed(2)} MiB${capped ? ", scan capped so current is at least this" : ""}) against a ${(this.quotaBytes / 1024 / 1024).toFixed(2)} MiB quota.`,
      );
    }
  }
}
