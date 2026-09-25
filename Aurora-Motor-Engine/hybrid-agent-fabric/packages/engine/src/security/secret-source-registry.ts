import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialBrokerLike, SecretMetadata } from "./credential-broker.js";
import { atomicWrite } from "../util/atomic-file.js";

export type SecretSourceKind = "command" | "onepassword" | "bitwarden";

export interface SecretSourceItem {
  secretName: string;
  reference: string;
  description?: string;
}

export interface SecretSourceRecord {
  id: string;
  name: string;
  kind: SecretSourceKind;
  executable: string;
  executableSha256: string;
  args?: string[];
  environmentVariables: string[];
  items: SecretSourceItem[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SecretSourceView extends Omit<SecretSourceRecord, "items" | "args"> {
  items: Array<{ secretName: string; description?: string }>;
  argumentCount: number;
}

function envName(value: string): string {
  if (!/^[A-Z_][A-Z0-9_]{0,199}$/.test(value)) throw new Error(`Invalid secret-source environment variable: ${value}`);
  return value;
}

function secretName(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(value)) throw new Error(`Invalid imported secret name: ${value}`);
  return value;
}

function validateExecutable(value: string): string {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("..")) throw new Error("Secret-source executable must be a safe absolute path.");
  return value;
}

function validateDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Secret-source executable SHA-256 is invalid.");
  return value.toLowerCase();
}

function buildArgs(source: SecretSourceRecord, item: SecretSourceItem): string[] {
  if (source.kind === "onepassword") return ["read", item.reference, "--no-newline"];
  if (source.kind === "bitwarden") return ["get", "password", item.reference, "--raw"];
  const args = source.args ?? [];
  if (!args.some((arg) => arg.includes("{reference}"))) throw new Error("Command secret source requires a {reference} argument placeholder.");
  return args.map((arg) => arg.replaceAll("{reference}", item.reference));
}

async function runBounded(input: { executable: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number }): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(input.executable, input.args, { env: input.env, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = []; let bytes = 0; let killedForLimit = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > input.maxBytes) { killedForLimit = true; child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs); timer.unref();
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (killedForLimit) return reject(new Error("secret_source_output_limit"));
      if (code !== 0) return reject(new Error(`secret_source_exit_${code ?? "signal"}`));
      const value = Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
      if (!value) return reject(new Error("secret_source_empty_value"));
      resolvePromise(value);
    });
  });
}

export class SecretSourceRegistry {
  private records: SecretSourceRecord[] = [];
  private loaded = false;

  constructor(private readonly rootPath: string, private readonly broker: CredentialBrokerLike) {}
  private get path(): string { return join(this.rootPath, "secret-sources", "registry.json"); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.records = Array.isArray(parsed) ? parsed as SecretSourceRecord[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }
  private async save(): Promise<void> { await atomicWrite(this.path, `${JSON.stringify(this.records, null, 2)}\n`); }
  private view(record: SecretSourceRecord): SecretSourceView {
    return {
      id: record.id, name: record.name, kind: record.kind, executable: record.executable,
      executableSha256: record.executableSha256,
      environmentVariables: [...record.environmentVariables],
      items: record.items.map((item) => ({ secretName: item.secretName, ...(item.description ? { description: item.description } : {}) })),
      argumentCount: record.args?.length ?? 0,
      enabled: record.enabled, createdAt: record.createdAt, updatedAt: record.updatedAt,
    };
  }

  async list(): Promise<SecretSourceView[]> { await this.load(); return this.records.map((record) => this.view(record)); }
  async get(id: string): Promise<SecretSourceRecord> {
    await this.load(); const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error(`Secret source ${id} not found.`);
    return structuredClone(record);
  }

  async add(input: {
    name: string;
    kind: SecretSourceKind;
    executable: string;
    executableSha256: string;
    args?: string[];
    environmentVariables?: string[];
    items: SecretSourceItem[];
  }): Promise<SecretSourceView> {
    await this.load();
    const name = input.name.trim();
    if (!name || name.length > 200 || this.records.some((record) => record.name.toLowerCase() === name.toLowerCase())) throw new Error("Secret-source name is invalid or already used.");
    if (input.items.length < 1 || input.items.length > 200) throw new Error("Secret source requires 1 to 200 items.");
    const items = input.items.map((item) => ({
      secretName: secretName(item.secretName),
      reference: item.reference.trim(),
      ...(item.description ? { description: item.description.slice(0, 500) } : {}),
    }));
    if (items.some((item) => !item.reference || item.reference.length > 2000)) throw new Error("Secret-source reference is invalid.");
    if (new Set(items.map((item) => item.secretName)).size !== items.length) throw new Error("Secret-source item names must be unique.");
    const args = (input.args ?? []).map((arg) => {
      if (typeof arg !== "string" || arg.length > 4000 || arg.includes("\0")) throw new Error("Secret-source argument is invalid.");
      return arg;
    }).slice(0, 100);
    const now = new Date().toISOString();
    const record: SecretSourceRecord = {
      id: randomUUID(), name, kind: input.kind,
      executable: validateExecutable(input.executable),
      executableSha256: validateDigest(input.executableSha256),
      ...(args.length ? { args } : {}),
      environmentVariables: [...new Set((input.environmentVariables ?? []).map(envName))].slice(0, 100),
      items, enabled: true, createdAt: now, updatedAt: now,
    };
    if (record.kind === "command" && !record.args?.some((arg) => arg.includes("{reference}"))) throw new Error("Command secret source requires a {reference} placeholder.");
    this.records.push(record); await this.save(); return this.view(record);
  }

  async setEnabled(id: string, enabled: boolean): Promise<SecretSourceView> {
    await this.load(); const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error(`Secret source ${id} not found.`);
    record.enabled = enabled; record.updatedAt = new Date().toISOString(); await this.save(); return this.view(record);
  }
  async remove(id: string): Promise<boolean> {
    await this.load(); const before = this.records.length; this.records = this.records.filter((record) => record.id !== id);
    if (before !== this.records.length) await this.save(); return before !== this.records.length;
  }

  async refresh(id: string, tenantId: string): Promise<{ sourceId: string; imported: SecretMetadata[]; failures: Array<{ secretName: string; errorCode: string }> }> {
    const source = await this.get(id);
    if (!source.enabled) throw new Error(`Secret source ${id} is disabled.`);
    const executablePath = await realpath(source.executable);
    const executable = await readFile(executablePath);
    const digest = createHash("sha256").update(executable).digest("hex");
    if (digest !== source.executableSha256) throw new Error("Secret-source executable SHA-256 verification failed.");
    const env: NodeJS.ProcessEnv = { PATH: "", HOME: this.rootPath };
    for (const name of source.environmentVariables) {
      const value = process.env[name];
      if (!value) throw new Error(`Secret-source environment variable ${name} is not set.`);
      env[name] = value;
    }
    const imported: SecretMetadata[] = []; const failures: Array<{ secretName: string; errorCode: string }> = [];
    for (const item of source.items) {
      try {
        const value = await runBounded({ executable: executablePath, args: buildArgs(source, item), env, timeoutMs: 15_000, maxBytes: 100_000 });
        imported.push(await this.broker.put({ tenantId, name: item.secretName, value, ...(item.description ? { description: item.description } : {}) }));
      } catch (error) {
        failures.push({ secretName: item.secretName, errorCode: error instanceof Error ? error.message.slice(0, 200) : "secret_source_error" });
      }
    }
    return { sourceId: id, imported, failures };
  }
}
