import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionSnapshot } from "../types.js";
import { atomicWrite } from "../util/atomic-file.js";

export interface SnapshotStore {
  save(snapshot: SessionSnapshot): Promise<void>;
  load(sessionId: string): Promise<SessionSnapshot | undefined>;
}

export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly rootPath: string) {}

  private pathFor(sessionId: string): string {
    return join(this.rootPath, "snapshots", `${sessionId}.json`);
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    await atomicWrite(this.pathFor(snapshot.sessionId), `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(sessionId), "utf8")) as SessionSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export class MemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, SessionSnapshot>();
  async save(snapshot: SessionSnapshot): Promise<void> {
    this.snapshots.set(snapshot.sessionId, structuredClone(snapshot));
  }
  async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    const snapshot = this.snapshots.get(sessionId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }
}
