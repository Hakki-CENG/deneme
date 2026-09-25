/**
 * Parallel Tool Execution — Aurora Cognitive Runtime
 *
 * Side-effect classification, parallel execution, barrier for irreversible actions.
 * Tool'ları kategorilere ayırır ve paralel çalıştırır.
 */

import { randomUUID } from "node:crypto";

/**
 * Tool side-effect classification.
 * 
 * Planın istediği kategoriler:
 * - read: Sadece okuma, hiçbir şeyi değiştirmez
 * - reversible_write: Yazma ama geri alınabilir
 * - external: Dış sistemlere erişir
 * - irreversible_write: Yazma ve geri alınamaz
 */
export type SideEffectCategory = "read" | "reversible_write" | "external" | "irreversible_write";

export interface ToolDescriptor {
  id: string;
  name: string;
  description: string;
  sideEffect: SideEffectCategory;
  /** Estimated duration in ms */
  estimatedDurationMs?: number;
  /** Whether this tool can be retried */
  retryable?: boolean;
  /** Dependencies on other tools */
  dependencies?: string[];
}

export interface ToolExecutionRequest {
  toolId: string;
  input: unknown;
  context: {
    tenantId: string;
    sessionId: string;
    turnId: string;
  };
}

export interface ToolExecutionResult {
  toolId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  sideEffect: SideEffectCategory;
  parallelGroup?: string;
}

export interface ParallelExecutionPlan {
  /** Parallel groups — tools in the same group can run concurrently */
  groups: ParallelGroup[];
  /** Total estimated duration */
  totalEstimatedMs: number;
  /** Tools that must run sequentially due to dependencies */
  sequentialChains: string[][];
}

export interface ParallelGroup {
  id: string;
  tools: ToolDescriptor[];
  canRunConcurrently: boolean;
  estimatedDurationMs: number;
}

export interface ParallelExecutionResult {
  results: ToolExecutionResult[];
  totalDurationMs: number;
  parallelGroupsUsed: number;
  toolsExecuted: number;
  toolsFailed: number;
  toolsSkipped: number;
}

/**
 * Tool Execution Classifier
 * 
 * Tool'ları side-effect kategorilerine göre sınıflandırır.
 */
export class ToolExecutionClassifier {
  private readonly toolRegistry = new Map<string, ToolDescriptor>();

  /**
   * Tool'u kaydet.
   */
  register(tool: ToolDescriptor): void {
    this.toolRegistry.set(tool.id, tool);
  }

  /**
   * Tool'un side-effect kategorisini belirle.
   */
  classify(toolId: string): SideEffectCategory {
    const tool = this.toolRegistry.get(toolId);
    return tool?.sideEffect ?? "read";
  }

  /**
   * Tool'un paralel çalıştırılıp çalıştırılamayacağını belirle.
   */
  canRunInParallel(toolId: string): boolean {
    const category = this.classify(toolId);
    return category === "read";
  }

  /**
   * Tool'un barrier'a ihtiyacı olup olmadığını belirle.
   */
  needsBarrier(toolId: string): boolean {
    const category = this.classify(toolId);
    return category === "irreversible_write" || category === "external";
  }

  /**
   * Tüm tool'ları kategorilere göre grupla.
   */
  groupByCategory(): Map<SideEffectCategory, ToolDescriptor[]> {
    const groups = new Map<SideEffectCategory, ToolDescriptor[]>();
    for (const tool of this.toolRegistry.values()) {
      const category = tool.sideEffect;
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push(tool);
    }
    return groups;
  }

  /**
   * Paralel execution planı oluştur.
   */
  createExecutionPlan(toolIds: string[]): ParallelExecutionPlan {
    const tools = toolIds
      .map(id => this.toolRegistry.get(id))
      .filter((t): t is ToolDescriptor => t !== undefined);

    // Group 1: Read-only tools (can run in parallel)
    const readTools = tools.filter(t => t.sideEffect === "read");
    
    // Group 2: Reversible writes (can run in parallel with each other)
    const reversibleWrites = tools.filter(t => t.sideEffect === "reversible_write");
    
    // Group 3: External calls (should be sequential or limited parallel)
    const externalCalls = tools.filter(t => t.sideEffect === "external");
    
    // Group 4: Irreversible writes (must be sequential with barrier)
    const irreversibleWrites = tools.filter(t => t.sideEffect === "irreversible_write");

    const groups: ParallelGroup[] = [];

    if (readTools.length > 0) {
      groups.push({
        id: `reads-${randomUUID().slice(0, 8)}`,
        tools: readTools,
        canRunConcurrently: true,
        estimatedDurationMs: Math.max(...readTools.map(t => t.estimatedDurationMs ?? 100)),
      });
    }

    if (reversibleWrites.length > 0) {
      groups.push({
        id: `rev-writes-${randomUUID().slice(0, 8)}`,
        tools: reversibleWrites,
        canRunConcurrently: true,
        estimatedDurationMs: Math.max(...reversibleWrites.map(t => t.estimatedDurationMs ?? 200)),
      });
    }

    if (externalCalls.length > 0) {
      groups.push({
        id: `external-${randomUUID().slice(0, 8)}`,
        tools: externalCalls,
        canRunConcurrently: false, // External calls should be sequential
        estimatedDurationMs: externalCalls.reduce((sum, t) => sum + (t.estimatedDurationMs ?? 500), 0),
      });
    }

    if (irreversibleWrites.length > 0) {
      groups.push({
        id: `irrev-writes-${randomUUID().slice(0, 8)}`,
        tools: irreversibleWrites,
        canRunConcurrently: false, // Must be sequential with barrier
        estimatedDurationMs: irreversibleWrites.reduce((sum, t) => sum + (t.estimatedDurationMs ?? 300), 0),
      });
    }

    const totalEstimatedMs = groups.reduce((sum, g) => sum + g.estimatedDurationMs, 0);

    return {
      groups,
      totalEstimatedMs,
      sequentialChains: this.findSequentialChains(tools),
    };
  }

  /**
   * Bağımlılıklara göre sıralı zincirler bul.
   */
  private findSequentialChains(tools: ToolDescriptor[]): string[][] {
    const chains: string[][] = [];
    const visited = new Set<string>();

    for (const tool of tools) {
      if (visited.has(tool.id)) continue;
      const chain = this.buildChain(tool, tools, visited);
      if (chain.length > 1) chains.push(chain);
    }

    return chains;
  }

  private buildChain(tool: ToolDescriptor, allTools: ToolDescriptor[], visited: Set<string>): string[] {
    if (visited.has(tool.id)) return [];
    visited.add(tool.id);

    const chain = [tool.id];

    // Find tools that depend on this one
    const dependents = allTools.filter(t => t.dependencies?.includes(tool.id));
    for (const dependent of dependents) {
      chain.push(...this.buildChain(dependent, allTools, visited));
    }

    return chain;
  }
}

/**
 * Parallel Tool Executor
 * 
 * Tool'ları paralel olarak çalıştırır.
 * Side-effect sınıflandırmasına göre barrier uygular.
 */
export class ParallelToolExecutor {
  constructor(private classifier: ToolExecutionClassifier) {}

  /**
   * Tool'ları paralel olarak çalıştır.
   */
  async execute(
    requests: ToolExecutionRequest[],
    executeFn: (request: ToolExecutionRequest) => Promise<unknown>
  ): Promise<ParallelExecutionResult> {
    const startTime = Date.now();
    const results: ToolExecutionResult[] = [];
    let toolsExecuted = 0;
    let toolsFailed = 0;
    let toolsSkipped = 0;
    let parallelGroupsUsed = 0;

    // Execution planı oluştur
    const plan = this.classifier.createExecutionPlan(requests.map(r => r.toolId));

    // Her grubu sırayla çalıştır
    for (const group of plan.groups) {
      const groupRequests = requests.filter(r => 
        group.tools.some(t => t.id === r.toolId)
      );

      if (groupRequests.length === 0) continue;

      if (group.canRunConcurrently) {
        // Paralel çalıştır
        const groupResults = await this.executeParallel(groupRequests, executeFn);
        results.push(...groupResults);
        parallelGroupsUsed++;
      } else {
        // Sırayla çalıştır (barrier)
        for (const request of groupRequests) {
          const result = await this.executeSingle(request, executeFn);
          results.push(result);
          
          // Eğer başarısız olursa zinciri kır
          if (!result.success) {
            toolsFailed++;
            // Kalan tool'ları atla
            const remaining = groupRequests.filter(r => r.toolId !== request.toolId);
            for (const r of remaining) {
              results.push({
                toolId: r.toolId,
                success: false,
                error: "Skipped due to previous failure in barrier group",
                durationMs: 0,
                sideEffect: this.classifier.classify(r.toolId),
              });
              toolsSkipped++;
            }
            break;
          }
        }
      }

      toolsExecuted += groupRequests.length;
    }

    const totalDurationMs = Date.now() - startTime;

    return {
      results,
      totalDurationMs,
      parallelGroupsUsed,
      toolsExecuted,
      toolsFailed,
      toolsSkipped,
    };
  }

  /**
   * Tool'ları paralel olarak çalıştır.
   */
  private async executeParallel(
    requests: ToolExecutionRequest[],
    executeFn: (request: ToolExecutionRequest) => Promise<unknown>
  ): Promise<ToolExecutionResult[]> {
    const promises = requests.map(request => this.executeSingle(request, executeFn));
    return Promise.all(promises);
  }

  /**
   * Tek bir tool'u çalıştır.
   */
  private async executeSingle(
    request: ToolExecutionRequest,
    executeFn: (request: ToolExecutionRequest) => Promise<unknown>
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const sideEffect = this.classifier.classify(request.toolId);

    try {
      const result = await executeFn(request);
      return {
        toolId: request.toolId,
        success: true,
        result,
        durationMs: Date.now() - startTime,
        sideEffect,
      };
    } catch (error) {
      return {
        toolId: request.toolId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        sideEffect,
      };
    }
  }
}

/**
 * Tool Execution Metrics
 * 
 * Tool execution metriklerini toplar.
 */
export class ToolExecutionMetrics {
  private readonly metrics = new Map<string, {
    totalCalls: number;
    successCalls: number;
    failedCalls: number;
    totalDurationMs: number;
    avgDurationMs: number;
    lastCalledAt: number;
  }>();

  /**
   * Tool execution sonucunu kaydet.
   */
  record(result: ToolExecutionResult): void {
    const existing = this.metrics.get(result.toolId) ?? {
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      lastCalledAt: 0,
    };

    existing.totalCalls++;
    if (result.success) existing.successCalls++;
    else existing.failedCalls++;
    existing.totalDurationMs += result.durationMs;
    existing.avgDurationMs = existing.totalDurationMs / existing.totalCalls;
    existing.lastCalledAt = Date.now();

    this.metrics.set(result.toolId, existing);
  }

  /**
   * Tool metriklerini al.
   */
  getMetrics(toolId: string): {
    totalCalls: number;
    successCalls: number;
    failedCalls: number;
    avgDurationMs: number;
    lastCalledAt: number;
  } | undefined {
    return this.metrics.get(toolId);
  }

  /**
   * Tüm metrikleri al.
   */
  getAllMetrics(): Map<string, {
    totalCalls: number;
    successCalls: number;
    failedCalls: number;
    avgDurationMs: number;
    lastCalledAt: number;
  }> {
    return new Map(this.metrics);
  }

  /**
   * En çok kullanılan tool'ları al.
   */
  getTopTools(limit = 10): Array<{ toolId: string; totalCalls: number; avgDurationMs: number }> {
    return [...this.metrics.entries()]
      .map(([toolId, m]) => ({ toolId, totalCalls: m.totalCalls, avgDurationMs: m.avgDurationMs }))
      .sort((a, b) => b.totalCalls - a.totalCalls)
      .slice(0, limit);
  }

  /**
   * En yavaş tool'ları al.
   */
  getSlowestTools(limit = 10): Array<{ toolId: string; avgDurationMs: number; totalCalls: number }> {
    return [...this.metrics.entries()]
      .map(([toolId, m]) => ({ toolId, avgDurationMs: m.avgDurationMs, totalCalls: m.totalCalls }))
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, limit);
  }
}

/**
 * Tool Execution Manager
 * 
 * Tüm tool execution bileşenlerini birleştirir.
 */
export class ToolExecutionManager {
  readonly classifier: ToolExecutionClassifier;
  readonly executor: ParallelToolExecutor;
  readonly metrics: ToolExecutionMetrics;

  constructor() {
    this.classifier = new ToolExecutionClassifier();
    this.executor = new ParallelToolExecutor(this.classifier);
    this.metrics = new ToolExecutionMetrics();
  }

  /**
   * Tool'u kaydet.
   */
  registerTool(tool: ToolDescriptor): void {
    this.classifier.register(tool);
  }

  /**
   * Tool'ları paralel olarak çalıştır.
   */
  async executeTools(
    requests: ToolExecutionRequest[],
    executeFn: (request: ToolExecutionRequest) => Promise<unknown>
  ): Promise<ParallelExecutionResult> {
    const result = await this.executor.execute(requests, executeFn);

    // Metrikleri kaydet
    for (const r of result.results) {
      this.metrics.record(r);
    }

    return result;
  }

  /**
   * Tool execution planını al.
   */
  getExecutionPlan(toolIds: string[]): ParallelExecutionPlan {
    return this.classifier.createExecutionPlan(toolIds);
  }

  /**
   * Tool metriklerini al.
   */
  getToolMetrics(toolId: string) {
    return this.metrics.getMetrics(toolId);
  }

  /**
   * En çok kullanılan tool'ları al.
   */
  getTopTools(limit?: number) {
    return this.metrics.getTopTools(limit);
  }

  /**
   * En yavaş tool'ları al.
   */
  getSlowestTools(limit?: number) {
    return this.metrics.getSlowestTools(limit);
  }
}
