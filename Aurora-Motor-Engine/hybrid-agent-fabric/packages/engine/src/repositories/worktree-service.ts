import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { SandboxFactory } from "../sandbox/sandbox.js";
import { auroraInteger, auroraText } from "../util/aurora-state.js";

export interface WorktreeRecord {
  path: string;
  branch: string;
  head?: string;
  bare: boolean;
  detached: boolean;
}

/**
 * Git worktrees for the main session.
 *
 * Child sessions already got an isolated worktree automatically. The gap the peers close and Aurora did
 * not is the *deliberate* one: "give me a clean branch to try this in, without disturbing what I have
 * open". This service creates that worktree from the session's repository and returns a path a new
 * session can be bound to.
 *
 * It is narrow on purpose:
 *
 * - the new tree is created inside the engine's own workspace root, never at a caller-supplied path,
 *   so a worktree cannot be used to write outside the sandboxed area;
 * - branch and base names are validated as plain git references, so neither can smuggle shell syntax;
 * - removal refuses a path outside the workspace root, and never touches the session's own workspace;
 * - every command runs through the same sandbox factory the git capabilities use.
 */
export class WorktreeService {
  constructor(
    private readonly factory: SandboxFactory,
    private readonly workspaceRoot: string,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: { workspacePath: string; branch: string; base?: string; signal?: AbortSignal }): Promise<WorktreeRecord & { createdAt: string }> {
    const workspacePath = auroraText(input.workspacePath, 4096, "Workspace path");
    const branch = reference(input.branch, "Branch");
    const base = input.base ? reference(input.base, "Base") : undefined;
    const target = resolve(join(this.workspaceRoot, `worktree-${branch.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40)}-${randomUUID().slice(0, 8)}`));
    if (!target.startsWith(resolve(this.workspaceRoot))) throw new Error("Worktree path escaped the workspace root.");
    await mkdir(this.workspaceRoot, { recursive: true });

    const command = `git worktree add -b ${quote(branch)} ${quote(target)}${base ? ` ${quote(base)}` : ""}`;
    const result = await this.run(workspacePath, command, input.signal);
    if (result.exitCode !== 0) throw new Error(`git worktree add failed: ${result.stdout.slice(0, 500)}`);

    const listed = await this.list(workspacePath, input.signal);
    const record = listed.find((item) => resolve(item.path) === target) ?? { path: target, branch, bare: false, detached: false };
    return { ...record, createdAt: new Date(this.now()).toISOString() };
  }

  async list(workspacePath: string, signal?: AbortSignal): Promise<WorktreeRecord[]> {
    const result = await this.run(workspacePath, "git worktree list --porcelain", signal);
    if (result.exitCode !== 0) return [];
    const records: WorktreeRecord[] = [];
    let current: Partial<WorktreeRecord> = {};
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (current.path) records.push({ path: current.path, branch: current.branch ?? "(detached)", ...(current.head ? { head: current.head } : {}), bare: current.bare ?? false, detached: current.detached ?? false });
        current = {};
        continue;
      }
      if (trimmed.startsWith("worktree ")) current.path = trimmed.slice("worktree ".length);
      else if (trimmed.startsWith("HEAD ")) current.head = trimmed.slice("HEAD ".length);
      else if (trimmed.startsWith("branch ")) current.branch = trimmed.slice("branch ".length).replace("refs/heads/", "");
      else if (trimmed === "bare") current.bare = true;
      else if (trimmed === "detached") current.detached = true;
    }
    if (current.path) records.push({ path: current.path, branch: current.branch ?? "(detached)", ...(current.head ? { head: current.head } : {}), bare: current.bare ?? false, detached: current.detached ?? false });
    return records;
  }

  async remove(input: { workspacePath: string; path: string; force?: boolean; signal?: AbortSignal }): Promise<{ path: string; removed: boolean; detail: string }> {
    const target = resolve(auroraText(input.path, 4096, "Worktree path"));
    if (!isAbsolute(target) || !target.startsWith(resolve(this.workspaceRoot))) {
      throw new Error("Only worktrees inside the engine workspace root can be removed.");
    }
    if (resolve(input.workspacePath) === target) throw new Error("A session cannot remove the worktree it is running in.");
    const result = await this.run(input.workspacePath, `git worktree remove ${input.force ? "--force " : ""}${quote(target)}`, input.signal);
    return { path: target, removed: result.exitCode === 0, detail: result.stdout.slice(0, 500) || (result.exitCode === 0 ? "removed" : "git refused the removal") };
  }

  private async run(workspacePath: string, command: string, signal?: AbortSignal): Promise<{ exitCode: number; stdout: string }> {
    const sandbox = await this.factory(workspacePath);
    try {
      const result = await sandbox.exec({
        command,
        timeoutMs: auroraInteger(120_000, 1000, 600_000, "Worktree timeout"),
        maxOutputChars: 200_000,
        ...(signal ? { signal } : {}),
      });
      // A killed sandbox reports a null exit code; treat that as a failure rather than a success.
      return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
    } finally {
      await sandbox.destroy();
    }
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function reference(value: string, label: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) || name.includes("..") || name.includes("//") || name.endsWith(".") || name.endsWith("/")) {
    throw new Error(`${label} must be a plain git reference.`);
  }
  return name;
}
