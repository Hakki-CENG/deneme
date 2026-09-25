import { z } from "zod";
import type { SandboxFactory, SandboxExecResult } from "../sandbox/sandbox.js";
import { defineCapability } from "./schema.js";

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function branchName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) || name.includes("..") || name.includes("//") || name.endsWith(".") || name.endsWith("/") || name.includes("@{")) {
    throw new Error("Git branch name is invalid.");
  }
  return name;
}

async function gitRun(
  factory: SandboxFactory,
  workspacePath: string,
  command: string,
  signal?: AbortSignal,
  maxOutputChars = 500_000,
): Promise<SandboxExecResult> {
  const sandbox = await factory(workspacePath);
  try {
    const result = await sandbox.exec({ command, timeoutMs: 120_000, maxOutputChars, ...(signal ? { signal } : {}) });
    if (result.exitCode !== 0) throw new Error(`Git command failed with exit ${result.exitCode}: ${result.stdout.slice(0, 4000)}`);
    return result;
  } finally {
    await sandbox.destroy();
  }
}

export function gitCapabilities(factory: SandboxFactory) {
  return [
    defineCapability(
      {
        id: "git.clone",
        version: "1.0.0",
        description: "Shallow-clone (depth 1, single branch) a public HTTPS repository into a directory inside the session workspace. Non-HTTPS URLs, embedded credentials and git@/file:// remotes are refused before any network call.",
        risk: "network",
        sideEffect: true,
        source: "core",
      },
      z.object({
        url: z.string().min(1).max(2000),
        intoDirectory: z.string().min(1).max(500),
        branch: z.string().min(1).max(200).optional(),
      }),
      async ({ url, intoDirectory, branch }, context) => {
        // P1.37 clone guard: HTTPS only, no credentials in the URL, no ssh/file
        // transports. The clone target stays inside the sandbox workspace.
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error("Git clone URL is not a valid URL.");
        }
        if (parsed.protocol !== "https:") throw new Error("Git clone URL must use https:// (ssh, git and file transports are refused).");
        if (parsed.username || parsed.password) throw new Error("Git clone URL must not embed credentials.");
        if (!parsed.hostname.includes(".")) throw new Error("Git clone URL must name a real host.");
        if (/\s/.test(intoDirectory) || intoDirectory.includes("..")) throw new Error("Git clone directory is invalid.");
        const target = branch ? `--branch ${quote(branchName(branch))}` : "";
        const result = await gitRun(
          factory,
          context.workspacePath,
          `git clone --depth 1 --single-branch ${target} ${quote(url)} -- ${quote(intoDirectory)}`,
          context.signal,
          200_000,
        );
        return { url: parsed.origin + parsed.pathname, directory: intoDirectory, output: result.stdout };
      },
    ),
    defineCapability(
      {
        id: "git.push",
        version: "1.0.0",
        description: "Push the current branch's HEAD to a remote branch. This is an external side effect and goes through the approval gate. Force pushes are refused.",
        risk: "external_side_effect",
        sideEffect: true,
        source: "core",
      },
      z.object({
        remote: z.string().min(1).max(200).default("origin"),
        branch: z.string().min(1).max(200),
      }),
      async ({ remote, branch }, context) => {
        const target = branchName(branch);
        // The refspec pins HEAD to an explicit remote branch; --force is
        // deliberately not offered — rewriting a shared remote is a policy
        // decision, not a tool default.
        const result = await gitRun(
          factory,
          context.workspacePath,
          `git push ${quote(remote)} HEAD:refs/heads/${quote(target)}`,
          context.signal,
          200_000,
        );
        return { remote, branch: target, output: result.stdout };
      },
    ),
    defineCapability(
      {
        id: "git.rollback",
        version: "1.0.0",
        description: "Roll the workspace repository back to a given commit (reset --hard) and optionally remove untracked files (clean -fd). Workspace-local recovery; never touches a remote.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        to: z.string().regex(/^[0-9a-f]{7,40}$/),
        clean: z.boolean().default(false),
      }),
      async ({ to, clean }, context) => {
        // Resolve the revision first: reset --hard to a name that does not
        // exist must fail before anything is discarded.
        const resolved = await gitRun(factory, context.workspacePath, `git rev-parse --verify ${quote(to)}^{commit}`, context.signal, 1000);
        const commit = resolved.stdout.trim();
        await gitRun(factory, context.workspacePath, `git reset --hard ${quote(commit)}`, context.signal);
        if (clean) await gitRun(factory, context.workspacePath, "git clean -fd", context.signal, 100_000);
        const status = await gitRun(factory, context.workspacePath, "git status --porcelain=v2 --branch", context.signal);
        return { commit, cleaned: clean, status: status.stdout.slice(0, 100_000) };
      },
    ),
    defineCapability(
      {
        id: "git.ci.status",
        version: "1.0.0",
        description: "Local CI status for the workspace repository: how the project verifies itself (detected recipe), ahead/behind versus the tracked remote, and working-tree cleanliness. This reads local facts; it does not invent hosted CI results.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => {
        const branchResult = await gitRun(factory, context.workspacePath, "git status --porcelain=v2 --branch", context.signal).catch(() => undefined);
        const ahead = Number(/ahead (\d+)/.exec(branchResult?.stdout ?? "")?.[1] ?? 0);
        const behind = Number(/behind (\d+)/.exec(branchResult?.stdout ?? "")?.[1] ?? 0);
        const dirty = (branchResult?.stdout ?? "").split("\n").some((line) => line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "));
        const remotes = await gitRun(factory, context.workspacePath, "git remote -v", context.signal, 10_000).catch(() => undefined);
        return {
          branch: /branch head \(([^)]+)\)/.exec(branchResult?.stdout ?? "")?.[1] ?? null,
          ahead,
          behind,
          dirty,
          hasRemote: Boolean(remotes?.stdout.trim()),
          // The verification recipe itself is the project's CI, detected the
          // same way verify.recipe detects it — reported as a pointer, not
          // re-implemented here.
          verifyWith: "verify.recipe",
        };
      },
      { idempotency: "inherent" },
    ),
    defineCapability(
      {
        id: "git.status",
        version: "1.0.0",
        description: "Read bounded porcelain-v2 repository status and current branch from the session sandbox.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => {
        const result = await gitRun(factory, context.workspacePath, "git status --porcelain=v2 --branch", context.signal);
        return { output: result.stdout, truncated: result.truncated, durationMs: result.durationMs };
      },
    ),
    defineCapability(
      {
        id: "git.diff",
        version: "1.0.0",
        description: "Read a bounded Git diff, optionally including staged changes or one confined pathspec.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      z.object({ staged: z.boolean().default(false), path: z.string().min(1).max(1000).optional() }),
      async ({ staged, path }, context) => {
        const command = `git diff --no-ext-diff ${staged ? "--cached " : ""}--${path ? ` ${quote(path)}` : ""}`;
        const result = await gitRun(factory, context.workspacePath, command, context.signal);
        return { output: result.stdout, staged, path: path ?? null, truncated: result.truncated, durationMs: result.durationMs };
      },
    ),
    defineCapability(
      {
        id: "git.branch.list",
        version: "1.0.0",
        description: "List local Git branches and the current branch without contacting a remote.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => {
        const result = await gitRun(factory, context.workspacePath, "git branch --format='%(if)%(HEAD)%(then)*%(else) %(end)%(refname:short)'", context.signal, 100_000);
        const branches = result.stdout.split("\n").filter(Boolean).map((line) => ({ current: line.startsWith("*"), name: line.slice(1) }));
        return { branches };
      },
    ),
    defineCapability(
      {
        id: "git.branch.create",
        version: "1.0.0",
        description: "Create and switch to a validated local Git branch inside the session sandbox.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({ name: z.string().min(1).max(200), startPoint: z.string().min(1).max(200).optional() }),
      async ({ name, startPoint }, context) => {
        const branch = branchName(name);
        const start = startPoint ? branchName(startPoint) : undefined;
        const result = await gitRun(factory, context.workspacePath, `git switch -c ${quote(branch)}${start ? ` ${quote(start)}` : ""}`, context.signal);
        return { branch, output: result.stdout };
      },
    ),
    defineCapability(
      {
        id: "git.branch.switch",
        version: "1.0.0",
        description: "Switch to a validated existing local Git branch inside the session sandbox.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({ name: z.string().min(1).max(200) }),
      async ({ name }, context) => {
        const branch = branchName(name);
        const result = await gitRun(factory, context.workspacePath, `git switch -- ${quote(branch)}`, context.signal);
        return { branch, output: result.stdout };
      },
    ),
    defineCapability(
      {
        id: "git.commit",
        version: "1.0.0",
        description: "Stage explicit pathspecs and create a local commit with hooks disabled. Never pushes to a remote.",
        risk: "workspace_write",
        sideEffect: true,
        source: "core",
      },
      z.object({
        message: z.string().min(1).max(10_000),
        paths: z.array(z.string().min(1).max(1000)).min(1).max(200),
        authorName: z.string().min(1).max(200).optional(),
        authorEmail: z.string().email().max(320).optional(),
      }),
      async ({ message, paths, authorName, authorEmail }, context) => {
        const pathArgs = paths.map(quote).join(" ");
        await gitRun(factory, context.workspacePath, `git add -- ${pathArgs}`, context.signal);
        const identity = `${authorName ? `-c user.name=${quote(authorName)} ` : ""}${authorEmail ? `-c user.email=${quote(authorEmail)} ` : ""}`;
        const result = await gitRun(factory, context.workspacePath, `git ${identity}commit --no-verify -m ${quote(message)}`, context.signal);
        const head = await gitRun(factory, context.workspacePath, "git rev-parse HEAD", context.signal, 1000);
        return { commit: head.stdout.trim(), output: result.stdout };
      },
    ),
  ];
}
