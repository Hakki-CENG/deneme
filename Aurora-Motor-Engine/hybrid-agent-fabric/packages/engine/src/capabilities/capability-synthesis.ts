/**
 * Capability Synthesis — Aurora Cognitive Runtime
 *
 * Generate missing capabilities.
 * Worker/sandbox execution.
 * Quarantine → supervised → trusted pipeline.
 */

import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

import { SANDBOX_WORKER_SOURCE, type SandboxWorkerResponse } from "./sandbox-worker.js";

/**
 * Capability trust level.
 */
export type CapabilityTrustLevel = "quarantine" | "supervised" | "trusted";

/**
 * Capability status.
 */
export type CapabilityStatus = "pending" | "active" | "suspended" | "deprecated";

/**
 * Generated capability.
 */
export interface GeneratedCapability {
  id: string;
  name: string;
  description: string;
  code: string;
  trustLevel: CapabilityTrustLevel;
  status: CapabilityStatus;
  generatedAt: string;
  generatedFrom: string;
  executionCount: number;
  successCount: number;
  failureCount: number;
  lastExecutedAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Sandbox execution result.
 */
export interface SandboxExecutionResult {
  id: string;
  capabilityId: string;
  success: boolean;
  output?: unknown | undefined;
  error?: string | undefined;
  /** Console output captured inside the isolate (bounded). */
  logs?: readonly string[] | undefined;
  durationMs: number;
  executedAt: string;
  sandboxId: string;
}

/**
 * Quarantine entry.
 */
export interface QuarantineEntry {
  id: string;
  capabilityId: string;
  reason: string;
  quarantinedAt: string;
  status: "quarantined" | "released" | "blocked";
  releasedAt?: string;
  releasedBy?: string;
}

/**
 * Capability Synthesis Manager
 * 
 * Generate missing capabilities.
 */
export class CapabilitySynthesisManager {
  private readonly capabilities = new Map<string, GeneratedCapability>();
  private readonly templates = new Map<string, {
    id: string;
    name: string;
    description: string;
    generate: (context: unknown) => string;
  }>();

  constructor() {
    this.registerDefaultTemplates();
  }

  /**
   * Default templates'leri kaydet.
   */
  private registerDefaultTemplates(): void {
    // HTTP Request capability template
    this.registerTemplate({
      id: "http-request",
      name: "HTTP Request",
      description: "Makes HTTP requests",
      generate: (context: unknown) => {
        const ctx = context as { url: string; method: string };
        return `
async function execute(input) {
  const response = await fetch('${ctx.url}', {
    method: '${ctx.method}',
    headers: input.headers || {},
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}
`;
      },
    });

    // File Read capability template
    this.registerTemplate({
      id: "file-read",
      name: "File Read",
      description: "Reads files from filesystem",
      generate: (context: unknown) => {
        const ctx = context as { path: string };
        return `
async function execute(input) {
  const fs = require('fs').promises;
  const content = await fs.readFile('${ctx.path}', 'utf-8');
  return { content };
}
`;
      },
    });

    // Database Query capability template
    this.registerTemplate({
      id: "database-query",
      name: "Database Query",
      description: "Executes database queries",
      generate: (context: unknown) => {
        const ctx = context as { query: string };
        return `
async function execute(input) {
  // Database query implementation
  return { rows: [], affectedRows: 0 };
}
`;
      },
    });
  }

  /**
   * Template kaydet.
   */
  registerTemplate(template: {
    id: string;
    name: string;
    description: string;
    generate: (context: unknown) => string;
  }): void {
    this.templates.set(template.id, template);
  }

  /**
   * Capability oluştur.
   */
  synthesizeCapability(params: {
    name: string;
    description: string;
    templateId?: string | undefined;
    context?: unknown;
    trustLevel?: CapabilityTrustLevel | undefined;
    /** Directly supplied capability body (used when no template applies). */
    code?: string | undefined;
  }): GeneratedCapability {
    const id = randomUUID();
    let code = params.code ?? "";

    if (!code && params.templateId) {
      const template = this.templates.get(params.templateId);
      if (template) {
        code = template.generate(params.context ?? {});
      }
    }

    const capability: GeneratedCapability = {
      id,
      name: params.name,
      description: params.description,
      code,
      trustLevel: params.trustLevel ?? "quarantine",
      status: "pending",
      generatedAt: new Date().toISOString(),
      generatedFrom: params.templateId ?? "manual",
      executionCount: 0,
      successCount: 0,
      failureCount: 0,
    };

    this.capabilities.set(id, capability);
    return capability;
  }

  /**
   * Capability'yi aktifleştir.
   */
  activateCapability(capabilityId: string): boolean {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) return false;

    capability.status = "active";
    return true;
  }

  /**
   * Capability'yi askıya al.
   */
  suspendCapability(capabilityId: string): boolean {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) return false;

    capability.status = "suspended";
    return true;
  }

  /**
   * Capability'yi kullanımdan kaldır.
   */
  deprecateCapability(capabilityId: string): boolean {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) return false;

    capability.status = "deprecated";
    return true;
  }

  /**
   * Execution sonucunu kaydet.
   */
  recordExecution(capabilityId: string, success: boolean): void {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) return;

    capability.executionCount++;
    if (success) capability.successCount++;
    else capability.failureCount++;
    capability.lastExecutedAt = new Date().toISOString();
  }

  /**
   * Tüm capability'leri al.
   */
  getCapabilities(): GeneratedCapability[] {
    return [...this.capabilities.values()];
  }

  /**
   * Trust level'a göre capability'leri al.
   */
  getCapabilitiesByTrustLevel(level: CapabilityTrustLevel): GeneratedCapability[] {
    return [...this.capabilities.values()].filter(c => c.trustLevel === level);
  }

  /**
   * Status'a göre capability'leri al.
   */
  getCapabilitiesByStatus(status: CapabilityStatus): GeneratedCapability[] {
    return [...this.capabilities.values()].filter(c => c.status === status);
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalCapabilities: number;
    byTrustLevel: Record<string, number>;
    byStatus: Record<string, number>;
    totalExecutions: number;
    successRate: number;
  } {
    const capabilities = [...this.capabilities.values()];
    const byTrustLevel: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let totalExecutions = 0;
    let totalSuccess = 0;

    for (const cap of capabilities) {
      byTrustLevel[cap.trustLevel] = (byTrustLevel[cap.trustLevel] ?? 0) + 1;
      byStatus[cap.status] = (byStatus[cap.status] ?? 0) + 1;
      totalExecutions += cap.executionCount;
      totalSuccess += cap.successCount;
    }

    return {
      totalCapabilities: capabilities.length,
      byTrustLevel,
      byStatus,
      totalExecutions,
      successRate: totalExecutions > 0 ? totalSuccess / totalExecutions : 0,
    };
  }
}

/**
 * Sandbox Executor
 * 
 * Worker/sandbox execution.
 */
export class SandboxExecutor {
  private readonly sandboxes = new Map<string, {
    id: string;
    name: string;
    status: "idle" | "running" | "stopped";
    createdAt: string;
  }>();

  private readonly defaultTimeoutMs: number;
  private readonly defaultHeapMb: number;

  constructor(options?: {
    defaultTimeoutMs?: number | undefined;
    defaultHeapMb?: number | undefined;
  }) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 5000;
    this.defaultHeapMb = options?.defaultHeapMb ?? 64;
  }

  /**
   * Sandbox oluştur.
   */
  createSandbox(name: string): string {
    const id = randomUUID();
    this.sandboxes.set(id, {
      id,
      name,
      status: "idle",
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  /**
   * Sandbox'ta çalıştır.
   */
  async executeInSandbox(
    sandboxId: string,
    code: string,
    input: unknown,
    options?: {
      timeoutMs?: number | undefined;
      maxOldGenerationSizeMb?: number | undefined;
    }
  ): Promise<SandboxExecutionResult> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox not found: ${sandboxId}`);
    }

    sandbox.status = "running";
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const heapMb = options?.maxOldGenerationSizeMb ?? this.defaultHeapMb;

    try {
      const result = await this.runInWorker(code, input, timeoutMs, heapMb);

      sandbox.status = "idle";

      if (!result.ok) {
        return {
          id: randomUUID(),
          capabilityId: "",
          success: false,
          error: result.error ?? "Sandbox execution failed",
          logs: result.logs,
          durationMs: Date.now() - startTime,
          executedAt: new Date().toISOString(),
          sandboxId,
        };
      }

      return {
        id: randomUUID(),
        capabilityId: "",
        success: true,
        output: result.output,
        logs: result.logs,
        durationMs: Date.now() - startTime,
        executedAt: new Date().toISOString(),
        sandboxId,
      };
    } catch (error) {
      sandbox.status = "idle";

      return {
        id: randomUUID(),
        capabilityId: "",
        success: false,
        error: error instanceof Error ? error.message : String(error),
        logs: [],
        durationMs: Date.now() - startTime,
        executedAt: new Date().toISOString(),
        sandboxId,
      };
    }
  }

  /**
   * Gerçek worker thread içinde çalıştır.
   *
   * İzolasyon: ayrı V8 isolate, resourceLimits ile heap sınırı, wall-clock
   * timeout sonrası zorla terminate, vm context içinde process/require yok.
   */
  private async runInWorker(
    code: string,
    input: unknown,
    timeoutMs: number,
    heapMb: number
  ): Promise<SandboxWorkerResponse> {
    return await new Promise<SandboxWorkerResponse>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const worker = new Worker(SANDBOX_WORKER_SOURCE, {
        eval: true,
        workerData: { code, input, timeoutMs },
        resourceLimits: {
          maxOldGenerationSizeMb: heapMb,
          maxYoungGenerationSizeMb: Math.max(4, Math.floor(heapMb / 4)),
          codeRangeSizeMb: 16,
          stackSizeMb: 4,
        },
        // Untrusted code must not inherit host stdio or env.
        stdin: false,
        stdout: true,
        stderr: true,
        env: Object.create(null) as NodeJS.ProcessEnv,
      });

      const finish = (response: SandboxWorkerResponse): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        void worker.terminate();
        resolve(response);
      };

      timer = setTimeout(() => {
        finish({
          ok: false,
          error: `Sandbox execution timed out after ${timeoutMs}ms`,
          logs: [],
        });
      }, timeoutMs + 250);
      // Do not keep the event loop alive purely for the sandbox watchdog.
      if (typeof timer.unref === "function") timer.unref();

      worker.on("message", (message: SandboxWorkerResponse) => {
        finish(message);
      });

      worker.on("error", (error: Error) => {
        finish({ ok: false, error: error.message, logs: [] });
      });

      worker.on("exit", (exitCode: number) => {
        if (exitCode !== 0) {
          finish({
            ok: false,
            error: `Sandbox worker exited with code ${exitCode}`,
            logs: [],
          });
          return;
        }
        // Normal exit without a message means the worker produced nothing.
        finish({ ok: false, error: "Sandbox produced no result", logs: [] });
      });
    });
  }

  /**
   * Sandbox'ı durdur.
   */
  stopSandbox(sandboxId: string): boolean {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return false;

    sandbox.status = "stopped";
    return true;
  }

  /**
   * Tüm sandbox'ları al.
   */
  getSandboxes(): Array<{
    id: string;
    name: string;
    status: string;
    createdAt: string;
  }> {
    return [...this.sandboxes.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalSandboxes: number;
    idleSandboxes: number;
    runningSandboxes: number;
    stoppedSandboxes: number;
  } {
    const sandboxes = [...this.sandboxes.values()];
    return {
      totalSandboxes: sandboxes.length,
      idleSandboxes: sandboxes.filter(s => s.status === "idle").length,
      runningSandboxes: sandboxes.filter(s => s.status === "running").length,
      stoppedSandboxes: sandboxes.filter(s => s.status === "stopped").length,
    };
  }
}

/**
 * Quarantine Manager
 * 
 * Quarantine → supervised → trusted pipeline.
 */
export class QuarantineManager {
  private readonly entries = new Map<string, QuarantineEntry>();
  private readonly promotionHistory = new Map<string, Array<{
    from: CapabilityTrustLevel;
    to: CapabilityTrustLevel;
    promotedAt: string;
    promotedBy: string;
  }>>();

  /**
   * Capability'yi karantinaya al.
   */
  quarantine(params: {
    capabilityId: string;
    reason: string;
  }): QuarantineEntry {
    const entry: QuarantineEntry = {
      id: randomUUID(),
      capabilityId: params.capabilityId,
      reason: params.reason,
      quarantinedAt: new Date().toISOString(),
      status: "quarantined",
    };

    this.entries.set(entry.id, entry);
    return entry;
  }

  /**
   * Capability'yi karantinadan çıkar.
   */
  release(entryId: string, releasedBy: string): boolean {
    const entry = this.entries.get(entryId);
    if (!entry || entry.status !== "quarantined") return false;

    entry.status = "released";
    entry.releasedAt = new Date().toISOString();
    entry.releasedBy = releasedBy;
    return true;
  }

  /**
   * Capability'yi engelle.
   */
  block(entryId: string): boolean {
    const entry = this.entries.get(entryId);
    if (!entry) return false;

    entry.status = "blocked";
    return true;
  }

  /**
   * Trust level promotion.
   */
  promoteTrustLevel(
    capabilityId: string,
    from: CapabilityTrustLevel,
    to: CapabilityTrustLevel,
    promotedBy: string
  ): boolean {
    // Promotion validation
    const validPromotions: Record<CapabilityTrustLevel, CapabilityTrustLevel[]> = {
      quarantine: ["supervised"],
      supervised: ["trusted"],
      trusted: [],
    };

    if (!validPromotions[from]?.includes(to)) return false;

    // Record promotion
    if (!this.promotionHistory.has(capabilityId)) {
      this.promotionHistory.set(capabilityId, []);
    }

    this.promotionHistory.get(capabilityId)!.push({
      from,
      to,
      promotedAt: new Date().toISOString(),
      promotedBy,
    });

    return true;
  }

  /**
   * Karantinadaki capability'leri al.
   */
  getQuarantinedCapabilities(): QuarantineEntry[] {
    return [...this.entries.values()].filter(e => e.status === "quarantined");
  }

  /**
   * Engellenen capability'leri al.
   */
  getBlockedCapabilities(): QuarantineEntry[] {
    return [...this.entries.values()].filter(e => e.status === "blocked");
  }

  /**
   * Promotion history'yi al.
   */
  getPromotionHistory(capabilityId: string): Array<{
    from: CapabilityTrustLevel;
    to: CapabilityTrustLevel;
    promotedAt: string;
    promotedBy: string;
  }> {
    return this.promotionHistory.get(capabilityId) ?? [];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalEntries: number;
    quarantined: number;
    released: number;
    blocked: number;
    totalPromotions: number;
  } {
    const entries = [...this.entries.values()];
    let totalPromotions = 0;
    for (const history of this.promotionHistory.values()) {
      totalPromotions += history.length;
    }

    return {
      totalEntries: entries.length,
      quarantined: entries.filter(e => e.status === "quarantined").length,
      released: entries.filter(e => e.status === "released").length,
      blocked: entries.filter(e => e.status === "blocked").length,
      totalPromotions,
    };
  }
}

/**
 * Capability Synthesis Pipeline
 * 
 * Quarantine → supervised → trusted pipeline.
 */
export class CapabilitySynthesisPipeline {
  readonly synthesis: CapabilitySynthesisManager;
  readonly sandbox: SandboxExecutor;
  readonly quarantine: QuarantineManager;

  constructor() {
    this.synthesis = new CapabilitySynthesisManager();
    this.sandbox = new SandboxExecutor();
    this.quarantine = new QuarantineManager();
  }

  /**
   * Capability oluştur ve karantinaya al.
   */
  async createAndQuarantine(params: {
    name: string;
    description: string;
    templateId?: string | undefined;
    context?: unknown;
    reason: string;
  }): Promise<{
    capability: GeneratedCapability;
    quarantineEntry: QuarantineEntry;
  }> {
    // Capability oluştur
    const capability = this.synthesis.synthesizeCapability({
      name: params.name,
      description: params.description,
      templateId: params.templateId,
      context: params.context,
      trustLevel: "quarantine",
    });

    // Karantinaya al
    const quarantineEntry = this.quarantine.quarantine({
      capabilityId: capability.id,
      reason: params.reason,
    });

    return { capability, quarantineEntry };
  }

  /**
   * Capability'yi sandbox'ta test et.
   */
  async testInSandbox(
    capabilityId: string,
    input: unknown
  ): Promise<SandboxExecutionResult> {
    const capability = this.synthesis.getCapabilities().find(c => c.id === capabilityId);
    if (!capability) {
      throw new Error(`Capability not found: ${capabilityId}`);
    }

    // Sandbox oluştur
    const sandboxId = this.sandbox.createSandbox(`test-${capability.name}`);

    // Sandbox'ta çalıştır
    const result = await this.sandbox.executeInSandbox(
      sandboxId,
      capability.code,
      input
    );

    // Sonucu kaydet
    this.synthesis.recordExecution(capabilityId, result.success);

    return result;
  }

  /**
   * Capability üret, karantinaya al ve gerçek sandbox'ta doğrula.
   *
   * FAZ 17-19 gate: "Eksik capability'yi üretti, sandbox'ta test etti".
   * Test başarısızsa capability karantinada kalır ve suspend edilir.
   */
  async synthesizeAndTest(params: {
    name: string;
    description: string;
    code: string;
    testInput: unknown;
    timeoutMs?: number | undefined;
  }): Promise<{
    capability: GeneratedCapability;
    quarantineEntry: QuarantineEntry;
    executionResult: SandboxExecutionResult;
  }> {
    const capability = this.synthesis.synthesizeCapability({
      name: params.name,
      description: params.description,
      code: params.code,
      trustLevel: "quarantine",
    });

    const quarantineEntry = this.quarantine.quarantine({
      capabilityId: capability.id,
      reason: "newly synthesized capability awaiting sandbox verification",
    });

    const sandboxId = this.sandbox.createSandbox(`synth-${capability.name}`);
    const executionResult = await this.sandbox.executeInSandbox(
      sandboxId,
      capability.code,
      params.testInput,
      { timeoutMs: params.timeoutMs }
    );

    this.synthesis.recordExecution(capability.id, executionResult.success);

    // A capability that failed its sandbox probe must never look healthy.
    if (executionResult.success) {
      this.synthesis.activateCapability(capability.id);
    } else {
      this.synthesis.suspendCapability(capability.id);
    }

    return { capability, quarantineEntry, executionResult };
  }

  /**
   * Capability'yi promoted et.
   */
  async promoteCapability(
    capabilityId: string,
    targetLevel: CapabilityTrustLevel,
    promotedBy: string
  ): Promise<boolean> {
    const capability = this.synthesis.getCapabilities().find(c => c.id === capabilityId);
    if (!capability) return false;

    const currentLevel = capability.trustLevel;
    const promoted = this.quarantine.promoteTrustLevel(
      capabilityId,
      currentLevel,
      targetLevel,
      promotedBy
    );

    if (promoted) {
      capability.trustLevel = targetLevel;
    }

    return promoted;
  }

  /**
   * Pipeline istatistiklerini al.
   */
  getStats(): {
    synthesis: ReturnType<CapabilitySynthesisManager["getStats"]>;
    sandbox: ReturnType<SandboxExecutor["getStats"]>;
    quarantine: ReturnType<QuarantineManager["getStats"]>;
  } {
    return {
      synthesis: this.synthesis.getStats(),
      sandbox: this.sandbox.getStats(),
      quarantine: this.quarantine.getStats(),
    };
  }
}
