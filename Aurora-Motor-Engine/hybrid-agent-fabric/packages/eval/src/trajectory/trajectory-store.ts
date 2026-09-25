/**
 * Trajectory Store
 * Persists and retrieves trajectories for analysis and comparison.
 */

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Trajectory } from "./types.js";

export class TrajectoryStore {
  private basePath: string;

  constructor(basePath: string = "packages/eval/results/trajectories") {
    this.basePath = basePath;
  }

  /** Save a trajectory */
  async save(trajectory: Trajectory): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
    const filePath = join(this.basePath, `${trajectory.id}.json`);
    await writeFile(filePath, JSON.stringify(trajectory, null, 2));
  }

  /** Load a trajectory by ID */
  async load(id: string): Promise<Trajectory | null> {
    try {
      const filePath = join(this.basePath, `${id}.json`);
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as Trajectory;
    } catch {
      return null;
    }
  }

  /** List all trajectories for a task */
  async listByTask(taskId: string): Promise<Trajectory[]> {
    const all = await this.list();
    return all.filter(t => t.taskId === taskId);
  }

  /** List all trajectories */
  async list(): Promise<Trajectory[]> {
    try {
      const files = await readdir(this.basePath);
      const trajectories: Trajectory[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await readFile(join(this.basePath, file), "utf-8");
        trajectories.push(JSON.parse(content) as Trajectory);
      }
      return trajectories;
    } catch {
      return [];
    }
  }

  /** Get the latest trajectory for a task */
  async latest(taskId: string): Promise<Trajectory | null> {
    const all = await this.listByTask(taskId);
    if (all.length === 0) return null;
    const sorted = all.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
    return sorted[0] ?? null;
  }

  /** Compare two trajectories by running the latest against a baseline */
  async getBaseline(taskId: string): Promise<Trajectory | null> {
    const all = await this.listByTask(taskId);
    if (all.length < 2) return null;
    // Return the second-latest as baseline
    const sorted = all.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
    return sorted[1] ?? null;
  }

  /** Delete old trajectories (keep last N per task) */
  async prune(keepPerTask: number = 10): Promise<number> {
    const all = await this.list();
    const byTask = new Map<string, Trajectory[]>();
    for (const t of all) {
      const list = byTask.get(t.taskId) ?? [];
      list.push(t);
      byTask.set(t.taskId, list);
    }

    let pruned = 0;
    for (const [, trajectories] of byTask) {
      const sorted = trajectories.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
      for (const t of sorted.slice(keepPerTask)) {
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(join(this.basePath, `${t.id}.json`));
          pruned++;
        } catch {
          // Ignore
        }
      }
    }
    return pruned;
  }
}
