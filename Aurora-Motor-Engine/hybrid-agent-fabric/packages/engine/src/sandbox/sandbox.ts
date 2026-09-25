import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { JsonValue } from "../types.js";
import { CloudSandboxGateway, type CloudSandboxGatewayOptions, type CloudSandboxProvider } from "./cloud-sandbox.js";

export interface SandboxExecRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
  /**
   * Incremental output sink. A synchronous command only needs the final transcript, but a shell that
   * outlives the call has to be readable *while it runs* — this is the seam that makes that possible
   * without a second process-spawning path to audit. Backends that only return a completed transcript
   * (the cloud gateway) simply never call it; readers must not assume it fires.
   */
  onOutput?: (chunk: string) => void;
}

export interface SandboxExecResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface Sandbox {
  readonly kind: string;
  readonly workspacePath: string;
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
  destroy(): Promise<void>;
}

function scrubEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL"];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(extra)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) environment[name] = value;
  }
  return environment;
}

async function assertInside(workspace: string, cwd: string): Promise<string> {
  const root = await realpath(workspace);
  const target = await realpath(resolve(workspace, cwd));
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error("Sandbox cwd escapes the assigned workspace.");
  return target;
}

async function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputChars: number;
    signal?: AbortSignal; onOutput?: ((chunk: string) => void) | undefined;
  },
): Promise<SandboxExecResult> {
  const start = Date.now();
  return await new Promise<SandboxExecResult>((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let truncated = false;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length >= options.maxOutputChars) {
        truncated = true;
        return;
      }
      const remaining = options.maxOutputChars - output.length;
      const text = chunk.toString("utf8");
      const accepted = text.slice(0, remaining);
      output += accepted;
      if (text.length > remaining) truncated = true;
      if (accepted && options.onOutput) {
        try {
          options.onOutput(accepted);
        } catch {
          // A broken reader must never kill the process it is reading.
        }
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const terminate = () => {
      if (child.exitCode !== null) return;
      if (process.platform === "win32") child.kill("SIGKILL");
      else {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref();
    const abort = () => terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    // A signal that was already aborted before the spawn never fires the listener, so a kill issued
    // in the gap between "start this" and "it is running" would otherwise be silently lost.
    if (options.signal?.aborted) terminate();

    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolvePromise({ exitCode: code, stdout: output, timedOut, truncated, durationMs: Date.now() - start });
    });
  });
}

/**
 * Per-command resource limits.
 *
 * A timeout bounds how *long* a command runs; it says nothing about how much of the machine it takes
 * while it does. A runaway build that eats all memory does not time out - it takes the host down with
 * the agent on it. Peers reached the same conclusion and added memory limits to their shell tool; the
 * container backends already had them, and the local backend is where the gap was.
 *
 * These are applied with `ulimit` inside the command's own shell, so they are inherited by everything
 * the command starts. They are resource hygiene, not a security boundary - the local backend never was
 * one, and a limit does not make it one.
 */
export interface SandboxResourceLimits {
  /** Address space per process, in megabytes (`ulimit -v`). */
  memoryMb?: number;
  /** CPU seconds per process (`ulimit -t`). A hard stop for spin loops that produce no output. */
  cpuSeconds?: number;
  /** Largest file the command may write, in megabytes (`ulimit -f`). */
  fileSizeMb?: number;
  /** Processes the command's user may hold (`ulimit -u`), which bounds fork bombs. */
  processes?: number;
}

/** Renders limits as a `ulimit` prefix. Unsupported limits are skipped rather than failing the call. */
export function resourceLimitPrefix(limits: SandboxResourceLimits | undefined): string {
  if (!limits) return "";
  const parts: string[] = [];
  if (limits.memoryMb && limits.memoryMb > 0) parts.push(`ulimit -v ${Math.floor(limits.memoryMb * 1024)} 2>/dev/null || true`);
  if (limits.cpuSeconds && limits.cpuSeconds > 0) parts.push(`ulimit -t ${Math.floor(limits.cpuSeconds)} 2>/dev/null || true`);
  if (limits.fileSizeMb && limits.fileSizeMb > 0) parts.push(`ulimit -f ${Math.floor(limits.fileSizeMb * 1024)} 2>/dev/null || true`);
  if (limits.processes && limits.processes > 0) parts.push(`ulimit -u ${Math.floor(limits.processes)} 2>/dev/null || true`);
  return parts.length ? `${parts.join("; ")}; ` : "";
}

/** Trusted-development backend. It confines cwd but is NOT an OS security boundary. */
export class LocalSandbox implements Sandbox {
  readonly kind = "local";
  constructor(readonly workspacePath: string, private readonly limits?: SandboxResourceLimits) {}

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    const cwd = await assertInside(this.workspacePath, request.cwd ?? ".");
    // Use cmd.exe on Windows, /bin/bash on Unix
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/bash";
    const shellArgs = isWindows ? ["/c", request.command] : ["-lc", `${resourceLimitPrefix(this.limits)}${request.command}`];
    return await runProcess(shell, shellArgs, {
      cwd,
      env: scrubEnvironment(request.env),
      timeoutMs: request.timeoutMs ?? 120_000,
      maxOutputChars: request.maxOutputChars ?? 100_000,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onOutput ? { onOutput: request.onOutput } : {}),
    });
  }
  async destroy(): Promise<void> {}
}

export interface DockerSandboxOptions {
  image?: string;
  memory?: string;
  cpus?: string;
  network?: "none" | string;
  /** Limits applied inside the container as well, so a single process cannot claim the whole cgroup. */
  limits?: SandboxResourceLimits;
}

export class DockerSandbox implements Sandbox {
  readonly kind = "docker";
  private readonly image: string;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly network: string;

  private readonly limits: SandboxResourceLimits | undefined;

  constructor(readonly workspacePath: string, options: DockerSandboxOptions = {}) {
    this.limits = options.limits;
    this.image = options.image ?? "python:3.13-slim";
    this.memory = options.memory ?? "1g";
    this.cpus = options.cpus ?? "1";
    this.network = options.network ?? "none";
  }

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    const root = await realpath(this.workspacePath);
    const relativeCwd = request.cwd ?? ".";
    const hostCwd = await assertInside(root, relativeCwd);
    const relative = hostCwd.slice(root.length).replace(/^\//, "");
    const containerCwd = relative ? `/workspace/${relative}` : "/workspace";
    const args = [
      "run", "--rm", "--init",
      "--network", this.network,
      "--memory", this.memory,
      "--cpus", this.cpus,
      "--pids-limit", "256",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
      "-v", `${root}:/workspace:rw`,
      "-w", containerCwd,
    ];
    for (const [name, value] of Object.entries(request.env ?? {})) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) args.push("-e", `${name}=${value}`);
    }
    args.push(this.image, "/bin/sh", "-lc", `${resourceLimitPrefix(this.limits)}${request.command}`);
    return await runProcess("docker", args, {
      cwd: root,
      env: scrubEnvironment(),
      timeoutMs: request.timeoutMs ?? 120_000,
      maxOutputChars: request.maxOutputChars ?? 100_000,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onOutput ? { onOutput: request.onOutput } : {}),
    });
  }
  async destroy(): Promise<void> {}
}

export interface SingularitySandboxOptions {
  /** Absolute SIF path or a digest-pinned docker/oras/library URI. */
  image: string;
  executable?: string;
  imageSha256?: string;
  allowUnpinnedImage?: boolean;
  network?: "none" | "host";
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/** Apptainer/Singularity backend for HPC environments. */
export class SingularitySandbox implements Sandbox {
  readonly kind = "singularity";
  private readonly executable: string;
  private readonly network: "none" | "host";

  constructor(readonly workspacePath: string, private readonly options: SingularitySandboxOptions) {
    if (!options.image.trim()) throw new Error("Singularity image is required.");
    const remoteImage = /^(?:docker|oras|library):\/\//.test(options.image);
    const digestPinned = /@sha256:[a-f0-9]{64}$/i.test(options.image);
    if (!options.allowUnpinnedImage && remoteImage && !digestPinned) {
      throw new Error("Remote Singularity images must be pinned with @sha256:<digest>.");
    }
    if (!options.allowUnpinnedImage && !remoteImage && !options.imageSha256) {
      throw new Error("Local Singularity images require imageSha256 unless allowUnpinnedImage is explicitly enabled.");
    }
    if (options.imageSha256 && !/^[a-f0-9]{64}$/i.test(options.imageSha256)) throw new Error("Singularity imageSha256 must be a 64-character SHA-256 digest.");
    this.executable = options.executable ?? "apptainer";
    if (!/^(?:[A-Za-z0-9._+-]+|\/[A-Za-z0-9._+/-]+)$/.test(this.executable) || this.executable.includes("..")) {
      throw new Error("Singularity executable is invalid.");
    }
    this.network = options.network ?? "none";
  }

  private async verifiedImage(): Promise<string> {
    if (/^(?:docker|oras|library):\/\//.test(this.options.image)) return this.options.image;
    const image = await realpath(this.options.image);
    if (this.options.imageSha256) {
      const actual = await sha256File(image);
      if (actual.toLowerCase() !== this.options.imageSha256.toLowerCase()) throw new Error("Singularity image SHA-256 verification failed.");
    }
    return image;
  }

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    const root = await realpath(this.workspacePath);
    const hostCwd = await assertInside(root, request.cwd ?? ".");
    const relativeCwd = hostCwd.slice(root.length).replace(/^\//, "");
    const containerCwd = relativeCwd ? `/workspace/${relativeCwd}` : "/workspace";
    const image = await this.verifiedImage();
    const args = [
      "exec",
      "--cleanenv",
      "--containall",
      "--no-home",
      "--writable-tmpfs",
      "--bind", `${root}:/workspace:rw`,
      "--pwd", containerCwd,
      ...(this.network === "none" ? ["--net", "--network", "none"] : []),
    ];
    for (const [name, value] of Object.entries(request.env ?? {})) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) args.push("--env", `${name}=${value}`);
    }
    args.push(image, "/bin/sh", "-lc", request.command);
    return await runProcess(this.executable, args, {
      cwd: root,
      env: scrubEnvironment(),
      timeoutMs: request.timeoutMs ?? 120_000,
      maxOutputChars: request.maxOutputChars ?? 100_000,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onOutput ? { onOutput: request.onOutput } : {}),
    });
  }

  async destroy(): Promise<void> {}
}

export interface SshSandboxOptions {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  remoteRoot?: string;
  syncFiles?: boolean;
  knownHostsFile?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class SshSandbox implements Sandbox {
  readonly kind = "ssh";
  private readonly target: string;
  private readonly remoteWorkspace: string;

  constructor(readonly workspacePath: string, private readonly options: SshSandboxOptions) {
    if (!/^[A-Za-z0-9._:-]+$/.test(options.host)) throw new Error("SSH host is invalid.");
    if (options.user && !/^[A-Za-z0-9._-]+$/.test(options.user)) throw new Error("SSH user is invalid.");
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error("SSH port is invalid.");
    const root = options.remoteRoot ?? "/tmp/haf-workspaces";
    if (!/^\/[A-Za-z0-9._/-]+$/.test(root) || root.includes("..")) throw new Error("SSH remote root must be a safe absolute path.");
    this.target = options.user ? `${options.user}@${options.host}` : options.host;
    this.remoteWorkspace = `${root.replace(/\/$/, "")}/${basename(resolve(workspacePath))}`;
  }

  private sshArgs(remoteCommand: string): string[] {
    return [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=10",
      ...(this.options.knownHostsFile ? ["-o", `UserKnownHostsFile=${this.options.knownHostsFile}`] : []),
      ...(this.options.port ? ["-p", String(this.options.port)] : []),
      ...(this.options.identityFile ? ["-i", this.options.identityFile] : []),
      this.target,
      remoteCommand,
    ];
  }

  private rsyncSshCommand(): string {
    const parts = [
      "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      ...(this.options.knownHostsFile ? ["-o", `UserKnownHostsFile=${this.options.knownHostsFile}`] : []),
      ...(this.options.port ? ["-p", String(this.options.port)] : []),
      ...(this.options.identityFile ? ["-i", this.options.identityFile] : []),
    ];
    return parts.map(shellQuote).join(" ");
  }

  private async syncToRemote(signal?: AbortSignal): Promise<void> {
    if (this.options.syncFiles === false) return;
    const mkdirResult = await runProcess("ssh", this.sshArgs(`mkdir -p -- ${shellQuote(this.remoteWorkspace)}`), {
      cwd: this.workspacePath,
      env: scrubEnvironment(),
      timeoutMs: 30_000,
      maxOutputChars: 10_000,
      ...(signal ? { signal } : {}),
    });
    if (mkdirResult.exitCode !== 0) throw new Error(`SSH workspace creation failed: ${mkdirResult.stdout}`);
    const result = await runProcess("rsync", [
      "-az", "--safe-links", "--exclude", ".git/objects/pack/", "-e", this.rsyncSshCommand(),
      `${resolve(this.workspacePath)}/`, `${this.target}:${this.remoteWorkspace}/`,
    ], {
      cwd: this.workspacePath,
      env: scrubEnvironment(),
      timeoutMs: 120_000,
      maxOutputChars: 50_000,
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0) throw new Error(`SSH workspace upload failed: ${result.stdout}`);
  }

  private async syncFromRemote(signal?: AbortSignal): Promise<void> {
    if (this.options.syncFiles === false) return;
    const result = await runProcess("rsync", [
      "-az", "--safe-links", "-e", this.rsyncSshCommand(),
      `${this.target}:${this.remoteWorkspace}/`, `${resolve(this.workspacePath)}/`,
    ], {
      cwd: this.workspacePath,
      env: scrubEnvironment(),
      timeoutMs: 120_000,
      maxOutputChars: 50_000,
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0) throw new Error(`SSH workspace download failed: ${result.stdout}`);
  }

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    const relativeCwd = request.cwd ?? ".";
    if (relativeCwd.startsWith("/") || relativeCwd.split(/[\\/]/).includes("..")) throw new Error("SSH cwd must remain inside the remote workspace.");
    await this.syncToRemote(request.signal);
    const remoteCwd = relativeCwd === "." ? this.remoteWorkspace : `${this.remoteWorkspace}/${relativeCwd}`;
    const exports = Object.entries(request.env ?? {})
      .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
      .join("; ");
    const script = `cd -- ${shellQuote(remoteCwd)} && ${exports ? `${exports}; ` : ""}exec /bin/bash -lc ${shellQuote(request.command)}`;
    const result = await runProcess("ssh", this.sshArgs(script), {
      cwd: this.workspacePath,
      env: scrubEnvironment(),
      timeoutMs: request.timeoutMs ?? 120_000,
      maxOutputChars: request.maxOutputChars ?? 100_000,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onOutput ? { onOutput: request.onOutput } : {}),
    });
    await this.syncFromRemote(request.signal);
    return result;
  }

  async destroy(): Promise<void> {
    // Remote workspaces are intentionally retained for reconnectable sessions.
  }
}

export type SandboxFactory = (workspacePath: string) => Promise<Sandbox>;

export type SandboxBackendKind = "local" | "docker" | "singularity" | "ssh" | CloudSandboxProvider;

export function createSandboxFactory(
  kind: SandboxBackendKind,
  options: {
    ssh?: SshSandboxOptions; singularity?: SingularitySandboxOptions; cloud?: CloudSandboxGatewayOptions;
    limits?: SandboxResourceLimits;
  } = {},
): SandboxFactory {
  return async (workspacePath) => {
    if (kind === "docker") return new DockerSandbox(workspacePath, options.limits ? { limits: options.limits } : {});
    if (kind === "singularity") {
      if (!options.singularity) throw new Error("Singularity sandbox configuration is required.");
      return new SingularitySandbox(workspacePath, options.singularity);
    }
    if (kind === "ssh") {
      if (!options.ssh) throw new Error("SSH sandbox configuration is required.");
      return new SshSandbox(workspacePath, options.ssh);
    }
    if (["modal", "daytona", "vercel", "kubernetes"].includes(kind)) {
      if (!options.cloud || options.cloud.provider !== kind) throw new Error(`${kind} sandbox gateway configuration is required.`);
      return new CloudSandboxGateway(workspacePath, options.cloud);
    }
    return new LocalSandbox(workspacePath, options.limits);
  };
}

export function sandboxResultAsJson(result: SandboxExecResult): JsonValue {
  return { ...result };
}
