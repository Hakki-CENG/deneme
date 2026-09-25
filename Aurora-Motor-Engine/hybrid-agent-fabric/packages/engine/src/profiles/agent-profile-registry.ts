import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../util/atomic-file.js";
import type { SessionAgentProfile } from "../types.js";

export interface AgentProfileRecord {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  instructions: string;
  allowedCapabilityIds?: string[];
  modelRoute?: string;
  fallbackModels: string[];
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

function modelRoute(value: string): string {
  const route = value.trim();
  const separator = route.indexOf(":");
  if (separator < 1 || separator === route.length - 1 || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(route.slice(0, separator)) || route.length > 300) {
    throw new Error("Agent profile model route must use provider:model format.");
  }
  return route;
}

function capabilities(value: string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const result = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (result.length > 500 || result.some((item) => !/^[a-zA-Z0-9_.:-]{1,200}$/.test(item))) throw new Error("Agent profile capability allowlist is invalid.");
  return result;
}

export class AgentProfileRegistry {
  private records: AgentProfileRecord[] = [];
  private loaded = false;

  constructor(private readonly rootPath: string) {}
  private get path(): string { return join(this.rootPath, "agent-profiles", "profiles.json"); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.records = Array.isArray(parsed) ? parsed as AgentProfileRecord[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.records, null, 2)}\n`);
  }

  async list(tenantId: string): Promise<AgentProfileRecord[]> {
    await this.load();
    return this.records.filter((record) => record.tenantId === tenantId).map((record) => structuredClone(record));
  }

  async get(id: string): Promise<AgentProfileRecord> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error(`Agent profile ${id} not found.`);
    return structuredClone(record);
  }

  async add(input: {
    tenantId: string;
    name: string;
    description?: string;
    instructions: string;
    allowedCapabilityIds?: string[];
    modelRoute?: string;
    fallbackModels?: string[];
  }): Promise<AgentProfileRecord> {
    await this.load();
    const name = input.name.trim();
    const instructions = input.instructions.trim();
    if (!name || name.length > 200 || !instructions || instructions.length > 50_000) throw new Error("Agent profile name/instructions are invalid.");
    if (this.records.some((item) => item.tenantId === input.tenantId && item.name.toLowerCase() === name.toLowerCase())) throw new Error(`Agent profile name ${name} already exists in this tenant.`);
    const now = new Date().toISOString();
    const allowedCapabilityIds = capabilities(input.allowedCapabilityIds);
    const record: AgentProfileRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      name,
      description: input.description?.trim().slice(0, 2000) ?? "",
      instructions,
      ...(allowedCapabilityIds ? { allowedCapabilityIds } : {}),
      ...(input.modelRoute ? { modelRoute: modelRoute(input.modelRoute) } : {}),
      fallbackModels: [...new Set((input.fallbackModels ?? []).map(modelRoute))].slice(0, 8),
      enabled: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    await this.save();
    return structuredClone(record);
  }

  async update(id: string, input: {
    name?: string;
    description?: string;
    instructions?: string;
    allowedCapabilityIds?: string[] | null;
    modelRoute?: string | null;
    fallbackModels?: string[];
    enabled?: boolean;
  }): Promise<AgentProfileRecord> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error(`Agent profile ${id} not found.`);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name || name.length > 200 || this.records.some((item) => item.id !== id && item.tenantId === record.tenantId && item.name.toLowerCase() === name.toLowerCase())) throw new Error("Agent profile name is invalid or already used.");
      record.name = name;
    }
    if (input.description !== undefined) record.description = input.description.trim().slice(0, 2000);
    if (input.instructions !== undefined) {
      const instructions = input.instructions.trim();
      if (!instructions || instructions.length > 50_000) throw new Error("Agent profile instructions are invalid.");
      record.instructions = instructions;
    }
    if (input.allowedCapabilityIds !== undefined) {
      const allowed = input.allowedCapabilityIds === null ? undefined : capabilities(input.allowedCapabilityIds);
      if (allowed) record.allowedCapabilityIds = allowed;
      else delete record.allowedCapabilityIds;
    }
    if (input.modelRoute !== undefined) {
      if (input.modelRoute === null || !input.modelRoute.trim()) delete record.modelRoute;
      else record.modelRoute = modelRoute(input.modelRoute);
    }
    if (input.fallbackModels !== undefined) record.fallbackModels = [...new Set(input.fallbackModels.map(modelRoute))].slice(0, 8);
    if (input.enabled !== undefined) record.enabled = input.enabled;
    record.version++;
    record.updatedAt = new Date().toISOString();
    await this.save();
    return structuredClone(record);
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (before !== this.records.length) await this.save();
    return before !== this.records.length;
  }

  async snapshot(id: string, tenantId: string): Promise<SessionAgentProfile> {
    const record = await this.get(id);
    if (record.tenantId !== tenantId) throw new Error("Agent profile does not belong to this tenant.");
    if (!record.enabled) throw new Error(`Agent profile ${id} is disabled.`);
    return {
      id: record.id,
      name: record.name,
      version: record.version,
      instructions: record.instructions,
      ...(record.allowedCapabilityIds ? { allowedCapabilityIds: [...record.allowedCapabilityIds] } : {}),
      ...(record.modelRoute ? { modelRoute: record.modelRoute } : {}),
      fallbackModels: [...record.fallbackModels],
    };
  }
}
