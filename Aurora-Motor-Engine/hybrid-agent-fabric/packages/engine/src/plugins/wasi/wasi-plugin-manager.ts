import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Capability, CapabilityRisk, JsonValue } from "../../types.js";
import type { CapabilityBroker } from "../../capabilities/capability-broker.js";
import type { HookBus, HookKind } from "../hook-bus.js";
import { asJsonValue } from "../../util/json.js";

export interface WasiPluginCapabilityManifest {
  id: string;
  action: string;
  description: string;
  risk: CapabilityRisk;
  sideEffect: boolean;
  inputSchema: JsonValue;
}

export interface WasiPluginHookManifest {
  hook: string;
  kind: HookKind;
  action: string;
  timeoutMs?: number;
}

export interface WasiPluginManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  apiVersion: "haf.plugin.v1";
  module: string;
  sha256: string;
  keyId: string;
  signature: string;
  capabilities: WasiPluginCapabilityManifest[];
  hooks: WasiPluginHookManifest[];
}

export interface WasiPluginManagerOptions {
  rootPath: string;
  runnerPath: string;
  trustedPublicKeys: Record<string, string>;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

interface InstalledPlugin {
  manifest: WasiPluginManifest;
  directory: string;
  modulePath: string;
  unregisterHooks: Array<() => void>;
  capabilityIds: string[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function publicKey(value: string) {
  if (/^[a-f0-9]{64}$/i.test(value)) {
    return createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(value, "hex")]),
      format: "der",
      type: "spki",
    });
  }
  return createPublicKey(value);
}

function signaturePayload(manifest: WasiPluginManifest): Buffer {
  const { signature: _signature, ...unsigned } = manifest;
  return Buffer.from(canonical(unsigned));
}

function validateManifest(value: unknown): WasiPluginManifest {
  const manifest = value as WasiPluginManifest;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.apiVersion !== "haf.plugin.v1") throw new Error("Unsupported WASI plugin manifest schema/API version.");
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(manifest.id) || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error("WASI plugin identity/version is invalid.");
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256) || !manifest.keyId || !manifest.signature) throw new Error("WASI plugin hash/signature metadata is invalid.");
  if (basename(manifest.module) !== manifest.module || !manifest.module.endsWith(".wasm")) throw new Error("WASI plugin module path must be a root .wasm file.");
  if (!Array.isArray(manifest.capabilities) || !Array.isArray(manifest.hooks)) throw new Error("WASI plugin capabilities/hooks must be arrays.");
  for (const capability of manifest.capabilities) {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(capability.id) || !capability.action || !capability.description) throw new Error("WASI plugin capability is invalid.");
  }
  for (const hook of manifest.hooks) {
    if (!hook.hook || !hook.action || !["observer", "guard", "transform"].includes(hook.kind)) throw new Error("WASI plugin hook is invalid.");
  }
  return manifest;
}

export class WasiPluginManager {
  private readonly installed = new Map<string, InstalledPlugin>();

  constructor(
    private readonly broker: CapabilityBroker,
    private readonly hooks: HookBus,
    private readonly options: WasiPluginManagerOptions,
  ) {}

  static canonicalManifestPayload(manifest: WasiPluginManifest): Buffer {
    return signaturePayload(manifest);
  }

  list(): Array<{ id: string; version: string; capabilities: string[]; hooks: string[] }> {
    return [...this.installed.values()].map((plugin) => ({
      id: plugin.manifest.id,
      version: plugin.manifest.version,
      capabilities: [...plugin.capabilityIds],
      hooks: plugin.manifest.hooks.map((hook) => `${hook.kind}:${hook.hook}`),
    }));
  }

  async install(sourceDirectory: string): Promise<{ id: string; version: string; capabilities: string[] }> {
    const source = resolve(sourceDirectory);
    const manifest = validateManifest(JSON.parse(await readFile(join(source, "plugin.json"), "utf8")));
    if (this.installed.has(manifest.id)) throw new Error(`WASI plugin ${manifest.id} is already installed.`);
    const sourceModule = resolve(source, manifest.module);
    if (!sourceModule.startsWith(`${source}${sep}`)) throw new Error("WASI plugin module escapes source directory.");
    const moduleBytes = await readFile(sourceModule);
    const hash = createHash("sha256").update(moduleBytes).digest("hex");
    if (hash !== manifest.sha256.toLowerCase()) throw new Error("WASI plugin module SHA-256 mismatch.");
    const trusted = this.options.trustedPublicKeys[manifest.keyId];
    if (!trusted) throw new Error(`WASI plugin signing key ${manifest.keyId} is not trusted.`);
    if (!verify(null, signaturePayload(manifest), publicKey(trusted), Buffer.from(manifest.signature, "base64"))) {
      throw new Error("WASI plugin manifest signature is invalid.");
    }

    const directory = join(this.options.rootPath, "plugins", "installed", manifest.id, manifest.version);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await cp(source, directory, { recursive: true, verbatimSymlinks: false });
    const modulePath = join(directory, manifest.module);
    await chmod(modulePath, 0o444);
    await chmod(directory, 0o555);
    const plugin: InstalledPlugin = { manifest, directory, modulePath, unregisterHooks: [], capabilityIds: [] };

    try {
      for (const item of manifest.capabilities) {
        const capabilityId = `plugin.${manifest.id}.${item.id}`;
        const capability: Capability = {
          descriptor: {
            id: capabilityId,
            version: manifest.version,
            description: item.description,
            risk: item.risk,
            sideEffect: item.sideEffect,
            inputSchema: item.inputSchema,
            source: "plugin",
          },
          validate(input) {
            if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("WASI plugin capability input must be an object.");
            return input as Record<string, JsonValue>;
          },
          execute: async (input, context) => {
            const output = await this.invoke(plugin, item.action, { input, context: {
              tenantId: context.tenantId,
              sessionId: context.sessionId,
              turnId: context.turnId,
              workspacePath: "/scratch",
            } });
            return asJsonValue(output?.result ?? output);
          },
        };
        this.broker.register(capability);
        plugin.capabilityIds.push(capabilityId);
      }
      for (const hook of manifest.hooks) {
        plugin.unregisterHooks.push(this.hooks.register({
          pluginId: manifest.id,
          hook: hook.hook,
          kind: hook.kind,
          ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
          callback: async (payload) => {
            const output = await this.invoke(plugin, hook.action, { payload });
            return output?.result ?? output;
          },
        }));
      }
      this.installed.set(manifest.id, plugin);
      return { id: manifest.id, version: manifest.version, capabilities: [...plugin.capabilityIds] };
    } catch (error) {
      for (const id of plugin.capabilityIds) this.broker.unregister(id);
      for (const unregister of plugin.unregisterHooks) unregister();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async uninstall(id: string): Promise<void> {
    const plugin = this.installed.get(id);
    if (!plugin) return;
    for (const capabilityId of plugin.capabilityIds) this.broker.unregister(capabilityId);
    for (const unregister of plugin.unregisterHooks) unregister();
    this.installed.delete(id);
    await chmod(plugin.directory, 0o700).catch(() => undefined);
    await rm(join(this.options.rootPath, "plugins", "installed", id), { recursive: true, force: true });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.installed.keys()].map((id) => this.uninstall(id)));
  }

  private async invoke(plugin: InstalledPlugin, action: string, input: unknown): Promise<any> {
    const scratch = join(this.options.rootPath, "plugins", "scratch", plugin.manifest.id, randomDirectory());
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, [this.options.runnerPath, plugin.modulePath, plugin.directory, scratch], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HAF_PLUGIN_ID: plugin.manifest.id,
        HAF_PLUGIN_ACTION: action,
        NODE_NO_WARNINGS: "1",
      },
    });
    const maxOutput = this.options.maxOutputBytes ?? 1024 * 1024;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length <= maxOutput) stdout = Buffer.concat([stdout, chunk]);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length <= 64 * 1024) stderr = Buffer.concat([stderr, chunk]);
    });
    child.stdin.end(JSON.stringify(input));
    const timeout = setTimeout(() => child.kill("SIGKILL"), this.options.defaultTimeoutMs ?? 5000);
    timeout.unref();
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (exitCode !== 0) throw new Error(`WASI plugin ${plugin.manifest.id}:${action} failed with exit ${exitCode}; stderr class=${stderr.length ? "present" : "empty"}.`);
      if (stdout.length > maxOutput) throw new Error("WASI plugin output exceeded the byte limit.");
      try { return JSON.parse(stdout.toString("utf8")); }
      catch { throw new Error("WASI plugin output is not valid JSON."); }
    } finally {
      clearTimeout(timeout);
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

function randomDirectory(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
