import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SessionLeaseManagerLike {
  acquire(sessionId: string): Promise<void>;
  release(sessionId: string): Promise<void>;
  releaseAll(): Promise<void>;
}

interface LeaseFile {
  token: string;
  pid: number;
  acquiredAt: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SessionLeaseManager implements SessionLeaseManagerLike {
  private readonly owned = new Map<string, string>();

  constructor(private readonly rootPath: string) {}

  private pathFor(sessionId: string): string {
    return join(this.rootPath, "leases", `${sessionId}.lock`);
  }

  async acquire(sessionId: string): Promise<void> {
    if (this.owned.has(sessionId)) return;
    const path = this.pathFor(sessionId);
    await mkdir(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = randomUUID();
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() } satisfies LeaseFile));
        await handle.close();
        this.owned.set(sessionId, token);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: LeaseFile | undefined;
        try {
          existing = JSON.parse(await readFile(path, "utf8")) as LeaseFile;
        } catch {
          // Corrupt lock is treated as stale; removal still races safely with wx creation.
        }
        if (existing && processAlive(existing.pid)) {
          throw new Error(`Session ${sessionId} is already active in process ${existing.pid}.`);
        }
        await rm(path, { force: true });
      }
    }
    throw new Error(`Could not acquire session lease for ${sessionId}.`);
  }

  async release(sessionId: string): Promise<void> {
    const token = this.owned.get(sessionId);
    if (!token) return;
    const path = this.pathFor(sessionId);
    try {
      const current = JSON.parse(await readFile(path, "utf8")) as LeaseFile;
      if (current.token === token) await rm(path, { force: true });
    } catch {
      // A missing/replaced lease is already no longer ours.
    }
    this.owned.delete(sessionId);
  }

  async releaseAll(): Promise<void> {
    await Promise.all([...this.owned.keys()].map((sessionId) => this.release(sessionId)));
  }
}
