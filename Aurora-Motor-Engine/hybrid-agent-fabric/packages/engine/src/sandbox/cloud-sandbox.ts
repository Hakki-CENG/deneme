import { basename, resolve } from "node:path";
import type { Sandbox, SandboxExecRequest, SandboxExecResult } from "./sandbox.js";

export type CloudSandboxProvider = "modal" | "daytona" | "vercel" | "kubernetes";

export interface CloudSandboxGatewayOptions {
  provider: CloudSandboxProvider;
  endpoint: string;
  bearerToken?: string;
  template?: string;
  cpu?: number;
  memoryMb?: number;
  lifetimeSeconds?: number;
  networkPolicy?: "none" | "allowlist" | "unrestricted";
  allowedHosts?: string[];
}

interface GatewaySandbox {
  sandboxId: string;
  status: string;
}

export class CloudSandboxGateway implements Sandbox {
  readonly kind: string;
  private sandboxId: string | undefined;
  private readonly endpoint: string;

  constructor(
    readonly workspacePath: string,
    private readonly options: CloudSandboxGatewayOptions,
  ) {
    this.kind = options.provider;
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("Cloud sandbox gateway endpoint must use HTTP(S).");
    this.endpoint = endpoint.toString().replace(/\/$/, "");
    if (options.networkPolicy === "allowlist" && !options.allowedHosts?.length) throw new Error("Allowlist network policy requires allowed hosts.");
  }

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    const cwd = request.cwd ?? ".";
    if (cwd.startsWith("/") || cwd.split(/[\\/]/).includes("..")) throw new Error("Cloud sandbox cwd escapes the assigned workspace.");
    const sandboxId = await this.ensureSandbox();
    const started = Date.now();
    const response = await this.request("POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`, {
      command: request.command,
      cwd,
      env: Object.fromEntries(Object.entries(request.env ?? {}).filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))),
      timeoutMs: request.timeoutMs ?? 120_000,
      maxOutputChars: request.maxOutputChars ?? 100_000,
    }, request.signal);
    if (typeof response?.stdout !== "string" || !(typeof response?.exitCode === "number" || response?.exitCode === null)) {
      throw new Error("Cloud sandbox gateway returned an invalid exec result.");
    }
    return {
      exitCode: response.exitCode,
      stdout: response.stdout,
      timedOut: response.timedOut === true,
      truncated: response.truncated === true,
      durationMs: typeof response.durationMs === "number" ? response.durationMs : Date.now() - started,
    };
  }

  async snapshot(): Promise<{ snapshotId: string }> {
    const sandboxId = await this.ensureSandbox();
    const result = await this.request("POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`, {});
    if (typeof result?.snapshotId !== "string") throw new Error("Cloud sandbox gateway returned no snapshot ID.");
    return { snapshotId: result.snapshotId };
  }

  async destroy(): Promise<void> {
    if (!this.sandboxId) return;
    const id = this.sandboxId;
    this.sandboxId = undefined;
    await this.request("DELETE", `/v1/sandboxes/${encodeURIComponent(id)}`).catch(() => undefined);
  }

  private async ensureSandbox(): Promise<string> {
    if (this.sandboxId) return this.sandboxId;
    const workspaceId = basename(resolve(this.workspacePath));
    const result = await this.request("POST", "/v1/sandboxes", {
      provider: this.options.provider,
      workspaceId,
      ...(this.options.template ? { template: this.options.template } : {}),
      limits: {
        cpu: this.options.cpu ?? 1,
        memoryMb: this.options.memoryMb ?? 1024,
        lifetimeSeconds: this.options.lifetimeSeconds ?? 3600,
      },
      network: {
        policy: this.options.networkPolicy ?? "none",
        allowedHosts: this.options.allowedHosts ?? [],
      },
    }) as GatewaySandbox;
    if (typeof result?.sandboxId !== "string" || !["ready", "running", "created"].includes(String(result.status))) {
      throw new Error("Cloud sandbox gateway failed to provision a ready sandbox.");
    }
    this.sandboxId = result.sandboxId;
    return this.sandboxId;
  }

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method,
      headers: {
        ...(this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Cloud sandbox gateway ${method} ${path} failed with HTTP ${response.status}.`);
    if (response.status === 204) return {};
    return await response.json();
  }
}
