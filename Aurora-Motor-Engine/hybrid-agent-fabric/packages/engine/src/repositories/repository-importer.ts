import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertSafeUrl } from "../capabilities/web.js";
import type { CredentialBrokerLike } from "../security/credential-broker.js";

export interface RepositoryImportRunnerInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type RepositoryImportRunner = (input: RepositoryImportRunnerInput) => Promise<{ exitCode: number | null; output: string }>;

export interface RepositoryImporterOptions {
  workspaceRoot: string;
  stateRoot: string;
  credentials: CredentialBrokerLike;
  urlGuard?: (url: string) => Promise<URL>;
  runner?: RepositoryImportRunner;
  maxFiles?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

async function defaultRunner(input: RepositoryImportRunnerInput): Promise<{ exitCode: number | null; output: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => { if (output.length < 100_000) output += chunk.toString("utf8").slice(0, 100_000 - output.length); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs); timer.unref();
    child.once("error", reject);
    child.once("close", (exitCode) => { clearTimeout(timer); resolvePromise({ exitCode, output }); });
  });
}

function branch(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) || name.includes("..") || name.includes("//") || name.includes("@{")) throw new Error("Repository branch name is invalid.");
  return name;
}

async function inventory(root: string, maxFiles: number, maxBytes: number): Promise<{ files: number; bytes: number }> {
  let files = 0; let bytes = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) { files++; continue; }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) { const info = await lstat(path); files++; bytes += info.size; }
      if (files > maxFiles || bytes > maxBytes) throw new Error("Imported repository exceeds configured file/byte limits.");
    }
  }
  await walk(root);
  return { files, bytes };
}

export class RepositoryImporter {
  private readonly urlGuard: (url: string) => Promise<URL>;
  private readonly runner: RepositoryImportRunner;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: RepositoryImporterOptions) {
    this.urlGuard = options.urlGuard ?? assertSafeUrl;
    this.runner = options.runner ?? defaultRunner;
    this.maxFiles = options.maxFiles ?? 100_000;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
  }

  async import(input: {
    tenantId: string;
    url: string;
    branch?: string;
    credentialSecretId?: string;
    credentialUsername?: string;
  }): Promise<{ workspacePath: string; origin: string; head: string; files: number; bytes: number }> {
    const url = await this.urlGuard(input.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Repository URL must be credential-free HTTPS without query or fragment.");
    const selectedBranch = branch(input.branch);
    await mkdir(this.options.workspaceRoot, { recursive: true, mode: 0o700 });
    const workspacePath = resolve(this.options.workspaceRoot, randomUUID());
    const helperRoot = resolve(this.options.stateRoot, "repository-import");
    await mkdir(helperRoot, { recursive: true, mode: 0o700 });
    const helperPath = join(helperRoot, `askpass-${randomUUID()}.sh`);
    let password: string | undefined;
    if (input.credentialSecretId) {
      const lease = await this.options.credentials.issueLease({
        tenantId: input.tenantId,
        secretId: input.credentialSecretId,
        capabilityId: "repository.import",
        audience: url.origin,
        ttlMs: 60_000,
        maxUses: 1,
      });
      password = await this.options.credentials.redeemLease({
        leaseId: lease.leaseId,
        tenantId: input.tenantId,
        capabilityId: "repository.import",
        audience: url.origin,
      });
      await writeFile(helperPath, "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' \"$HAF_GIT_USERNAME\";; *) printf '%s\\n' \"$HAF_GIT_PASSWORD\";; esac\n", { mode: 0o700 });
      await chmod(helperPath, 0o700);
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: helperRoot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...(password ? {
        GIT_ASKPASS: helperPath,
        HAF_GIT_USERNAME: input.credentialUsername?.trim() || "x-access-token",
        HAF_GIT_PASSWORD: password,
      } : {}),
    };
    try {
      const args = [
        "-c", "credential.helper=",
        "-c", "http.followRedirects=false",
        "clone", "--depth", "1", "--no-tags", "--filter=blob:none",
        ...(selectedBranch ? ["--branch", selectedBranch, "--single-branch"] : []),
        "--", url.toString(), workspacePath,
      ];
      const cloned = await this.runner({ command: "git", args, cwd: this.options.workspaceRoot, env, timeoutMs: this.timeoutMs });
      if (cloned.exitCode !== 0) throw new Error(`Repository clone failed: ${cloned.output.slice(0, 4000)}`);
      const stats = await inventory(workspacePath, this.maxFiles, this.maxBytes);
      const revision = await this.runner({ command: "git", args: ["-C", workspacePath, "rev-parse", "HEAD"], cwd: this.options.workspaceRoot, env: { PATH: process.env.PATH ?? "", HOME: helperRoot }, timeoutMs: 30_000 });
      if (revision.exitCode !== 0 || !/^[a-f0-9]{40,64}$/i.test(revision.output.trim())) throw new Error("Imported repository HEAD could not be verified.");
      return { workspacePath, origin: url.origin, head: revision.output.trim(), ...stats };
    } catch (error) {
      await rm(workspacePath, { recursive: true, force: true });
      throw error;
    } finally {
      password = undefined;
      await rm(helperPath, { force: true });
    }
  }
}
