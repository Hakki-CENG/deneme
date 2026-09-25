import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult, InputSource, JsonValue } from "../types.js";
import type { Supervisor } from "../runtime/supervisor.js";
import type { DurableScheduler, Schedule } from "../scheduler/scheduler.js";
import { atomicWrite } from "../util/atomic-file.js";

export type AutomationTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; schedule: Schedule }
  | { kind: "webhook"; eventType: string; secretEnvironmentVariable?: string };

export interface Automation {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  sessionId: string;
  prompt: string;
  trigger: AutomationTrigger;
  enabled: boolean;
  timeoutMs: number;
  model?: string;
  schedulerJobId?: string;
  managedBy?: {
    kind: "git_sync";
    sourceId: string;
    key: string;
    entrySha256: string;
    manifestSha256: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  tenantId: string;
  sessionId: string;
  source: "manual" | "webhook";
  status: "running" | "completed" | "failed" | "cancelled" | "uncertain";
  startedAt: string;
  completedAt?: string;
  commandId: string;
  errorCode?: string;
}

export class AutomationService {
  private automations: Automation[] = [];
  private runs: AutomationRun[] = [];
  private loaded = false;

  constructor(
    private readonly rootPath: string,
    private readonly supervisor: Supervisor,
    private readonly scheduler: DurableScheduler,
  ) {}

  private get automationsPath(): string { return join(this.rootPath, "automation", "automations.json"); }
  private get runsPath(): string { return join(this.rootPath, "automation", "runs.json"); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.automationsPath, "utf8")) as unknown;
      this.automations = Array.isArray(parsed) ? parsed as Automation[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const parsed = JSON.parse(await readFile(this.runsPath, "utf8")) as unknown;
      this.runs = Array.isArray(parsed) ? parsed as AutomationRun[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // A process restart makes in-flight outcomes uncertain; never claim success or replay.
    for (const run of this.runs) {
      if (run.status === "running") {
        run.status = "uncertain";
        run.completedAt = new Date().toISOString();
        run.errorCode = "PROCESS_RESTARTED";
      }
    }
    this.loaded = true;
    await this.saveRuns();
  }

  private async saveAutomations(): Promise<void> {
    await atomicWrite(this.automationsPath, `${JSON.stringify(this.automations, null, 2)}\n`);
  }
  private async saveRuns(): Promise<void> {
    await atomicWrite(this.runsPath, `${JSON.stringify(this.runs.slice(-5000), null, 2)}\n`);
  }

  async create(input: {
    tenantId: string;
    name: string;
    description?: string;
    sessionId: string;
    prompt: string;
    trigger: AutomationTrigger;
    enabled?: boolean;
    timeoutMs?: number;
    model?: string;
    managedBy?: Automation["managedBy"];
  }): Promise<Automation> {
    await this.load();
    if (!input.name.trim() || !input.prompt.trim()) throw new Error("Automation name and prompt are required.");
    const session = await this.supervisor.getSession(input.sessionId);
    if (session.tenantId !== input.tenantId) throw new Error("Automation session belongs to a different tenant.");
    if (input.trigger.kind === "webhook") {
      if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(input.trigger.eventType)) throw new Error("Webhook event type is invalid.");
      if (input.trigger.secretEnvironmentVariable && !/^[A-Z_][A-Z0-9_]*$/.test(input.trigger.secretEnvironmentVariable)) {
        throw new Error("Webhook secret must be referenced by environment variable name.");
      }
    }
    const now = new Date().toISOString();
    const automation: Automation = {
      id: randomUUID(),
      tenantId: input.tenantId,
      name: input.name.trim(),
      ...(input.description ? { description: input.description } : {}),
      sessionId: input.sessionId,
      prompt: input.prompt,
      trigger: input.trigger,
      enabled: input.enabled ?? true,
      timeoutMs: Math.min(Math.max(input.timeoutMs ?? 30 * 60_000, 1000), 24 * 60 * 60_000),
      ...(input.model ? { model: input.model } : {}),
      ...(input.managedBy ? { managedBy: structuredClone(input.managedBy) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    if (automation.enabled && automation.trigger.kind === "schedule") {
      const job = await this.scheduler.create({
        tenantId: automation.tenantId,
        sessionId: automation.sessionId,
        prompt: this.scheduledPrompt(automation),
        schedule: automation.trigger.schedule,
        label: `automation:${automation.id}`,
      });
      automation.schedulerJobId = job.id;
    }
    this.automations.push(automation);
    await this.saveAutomations();
    return structuredClone(automation);
  }

  async list(tenantId?: string): Promise<Automation[]> {
    await this.load();
    return this.automations.filter((item) => !tenantId || item.tenantId === tenantId).map((item) => structuredClone(item));
  }

  async get(id: string): Promise<Automation> {
    await this.load();
    const automation = this.automations.find((item) => item.id === id);
    if (!automation) throw new Error(`Automation ${id} not found.`);
    return structuredClone(automation);
  }

  async setEnabled(id: string, enabled: boolean): Promise<Automation> {
    await this.load();
    const automation = this.automations.find((item) => item.id === id);
    if (!automation) throw new Error(`Automation ${id} not found.`);
    automation.enabled = enabled;
    automation.updatedAt = new Date().toISOString();
    if (automation.trigger.kind === "schedule") {
      if (automation.schedulerJobId) {
        await this.scheduler.setStatus(automation.schedulerJobId, enabled ? "active" : "paused");
      } else if (enabled) {
        const job = await this.scheduler.create({
          tenantId: automation.tenantId,
          sessionId: automation.sessionId,
          prompt: this.scheduledPrompt(automation),
          schedule: automation.trigger.schedule,
          label: `automation:${automation.id}`,
        });
        automation.schedulerJobId = job.id;
      }
    }
    await this.saveAutomations();
    return structuredClone(automation);
  }

  async reconcileGitManaged(input: {
    sourceId: string;
    key: string;
    entrySha256: string;
    manifestSha256: string;
    tenantId: string;
    name: string;
    description?: string;
    sessionId: string;
    prompt: string;
    trigger: AutomationTrigger;
    enabled: boolean;
    timeoutMs?: number;
    model?: string;
  }): Promise<Automation> {
    await this.load();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.key)) throw new Error("Git-managed automation key is invalid.");
    if (!/^[a-f0-9]{64}$/i.test(input.entrySha256) || !/^[a-f0-9]{64}$/i.test(input.manifestSha256)) throw new Error("Git-managed automation hashes are invalid.");
    const existing = this.automations.find((item) => item.tenantId === input.tenantId && item.managedBy?.kind === "git_sync" && item.managedBy.sourceId === input.sourceId && item.managedBy.key === input.key);
    if (!existing) return await this.create({
      tenantId: input.tenantId, name: input.name, ...(input.description ? { description: input.description } : {}),
      sessionId: input.sessionId, prompt: input.prompt, trigger: input.trigger, enabled: input.enabled,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}), ...(input.model ? { model: input.model } : {}),
      managedBy: { kind: "git_sync", sourceId: input.sourceId, key: input.key, entrySha256: input.entrySha256, manifestSha256: input.manifestSha256 },
    });
    const session = await this.supervisor.getSession(input.sessionId);
    if (session.tenantId !== input.tenantId) throw new Error("Git-managed automation session belongs to a different tenant.");
    if (!input.name.trim() || !input.prompt.trim() || input.name.length > 200 || input.prompt.length > 50_000) throw new Error("Git-managed automation name or prompt is invalid.");
    if (input.trigger.kind === "webhook" && (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(input.trigger.eventType) || input.trigger.secretEnvironmentVariable && !/^[A-Z_][A-Z0-9_]*$/.test(input.trigger.secretEnvironmentVariable))) {
      throw new Error("Git-managed webhook trigger is invalid.");
    }
    if (existing.schedulerJobId) {
      await this.scheduler.setStatus(existing.schedulerJobId, "cancelled");
      delete existing.schedulerJobId;
    }
    existing.name = input.name.trim();
    if (input.description) existing.description = input.description; else delete existing.description;
    existing.sessionId = input.sessionId;
    existing.prompt = input.prompt;
    existing.trigger = structuredClone(input.trigger);
    existing.enabled = input.enabled;
    existing.timeoutMs = Math.min(Math.max(input.timeoutMs ?? 30 * 60_000, 1000), 24 * 60 * 60_000);
    if (input.model) existing.model = input.model; else delete existing.model;
    existing.managedBy = { kind: "git_sync", sourceId: input.sourceId, key: input.key, entrySha256: input.entrySha256, manifestSha256: input.manifestSha256 };
    existing.updatedAt = new Date().toISOString();
    if (existing.enabled && existing.trigger.kind === "schedule") {
      const job = await this.scheduler.create({
        tenantId: existing.tenantId, sessionId: existing.sessionId, prompt: this.scheduledPrompt(existing),
        schedule: existing.trigger.schedule, label: `automation:${existing.id}`,
      });
      existing.schedulerJobId = job.id;
    }
    await this.saveAutomations();
    return structuredClone(existing);
  }

  async disableGitManagedMissing(sourceId: string, tenantId: string, retainedKeys: Set<string>): Promise<string[]> {
    await this.load();
    const disabled: string[] = [];
    for (const automation of this.automations.filter((item) => item.tenantId === tenantId && item.managedBy?.kind === "git_sync" && item.managedBy.sourceId === sourceId && !retainedKeys.has(item.managedBy.key) && item.enabled)) {
      await this.setEnabled(automation.id, false);
      disabled.push(automation.id);
    }
    return disabled;
  }

  async dispatch(id: string, source: "manual" | "webhook", eventData?: JsonValue): Promise<AutomationRun> {
    await this.load();
    const automation = this.automations.find((item) => item.id === id);
    if (!automation) throw new Error(`Automation ${id} not found.`);
    if (!automation.enabled) throw new Error(`Automation ${id} is disabled.`);
    if (source === "webhook" && automation.trigger.kind !== "webhook") throw new Error("Automation is not webhook-triggered.");
    const runId = randomUUID();
    const commandId = `automation:${automation.id}:${runId}`;
    const run: AutomationRun = {
      id: runId,
      automationId: automation.id,
      tenantId: automation.tenantId,
      sessionId: automation.sessionId,
      source,
      status: "running",
      startedAt: new Date().toISOString(),
      commandId,
    };
    this.runs.push(run);
    await this.saveRuns();

    if (automation.model) {
      const selection = await this.supervisor.dispatch({
        protocolVersion: 1,
        commandId: `${commandId}:model`,
        clientId: `automation:${automation.id}`,
        tenantId: automation.tenantId,
        sessionId: automation.sessionId,
        kind: "model.select",
        source: "api",
        issuedAt: new Date().toISOString(),
        payload: { model: automation.model },
      });
      if (selection.status !== "completed") {
        run.status = selection.status === "uncertain" ? "uncertain" : "failed";
        run.errorCode = selection.error?.code ?? "MODEL_SELECTION_FAILED";
        run.completedAt = new Date().toISOString();
        await this.saveRuns();
        return structuredClone(run);
      }
    }

    const prompt = source === "webhook"
      ? `<UNTRUSTED_WEBHOOK_EVENT type="${automation.trigger.kind === "webhook" ? automation.trigger.eventType : "unknown"}">\n${JSON.stringify(eventData ?? null)}\n</UNTRUSTED_WEBHOOK_EVENT>\n\n${automation.prompt}`
      : automation.prompt;
    const inputSource: InputSource = source === "webhook" ? "webhook" : "api";
    const commandPromise = this.supervisor.dispatch({
      protocolVersion: 1,
      commandId,
      clientId: `automation:${automation.id}`,
      tenantId: automation.tenantId,
      sessionId: automation.sessionId,
      kind: "session.prompt",
      source: inputSource,
      issuedAt: new Date().toISOString(),
      payload: { text: prompt, automationId: automation.id, runId },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        commandPromise,
        new Promise<CommandResult>((resolve) => {
          timer = setTimeout(() => resolve({
            commandId,
            status: "rejected",
            error: { code: "AUTOMATION_TIMEOUT", message: "Automation exceeded its timeout.", retryable: false },
          }), automation.timeoutMs);
          timer.unref();
        }),
      ]);
      if (result.error?.code === "AUTOMATION_TIMEOUT") {
        await this.supervisor.dispatch({
          protocolVersion: 1,
          commandId: `${commandId}:cancel`,
          clientId: `automation:${automation.id}`,
          tenantId: automation.tenantId,
          sessionId: automation.sessionId,
          kind: "session.cancel",
          source: "api",
          issuedAt: new Date().toISOString(),
          payload: {},
        });
        run.status = "cancelled";
      } else run.status = result.status === "completed" ? "completed" : result.status === "uncertain" ? "uncertain" : "failed";
      if (result.error) run.errorCode = result.error.code;
    } finally {
      if (timer) clearTimeout(timer);
      run.completedAt = new Date().toISOString();
      await this.saveRuns();
    }
    return structuredClone(run);
  }

  async listRuns(automationId: string, limit = 100): Promise<AutomationRun[]> {
    await this.load();
    return this.runs.filter((run) => run.automationId === automationId).slice(-limit).reverse().map((run) => structuredClone(run));
  }

  private scheduledPrompt(automation: Automation): string {
    return `${automation.prompt}\n\n[AUTOMATION_CONTEXT id="${automation.id}" trigger="schedule"]`;
  }
}
