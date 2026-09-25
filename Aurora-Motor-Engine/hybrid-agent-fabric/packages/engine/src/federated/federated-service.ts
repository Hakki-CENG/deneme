/**
 * Federated/Edge Service
 * Run models/agents locally or on-premise without moving data to cloud.
 * On-device inference, local model management, air-gapped operation.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

// ─── Types ───

export type DeploymentTarget = "local" | "edge" | "on_premise" | "hybrid";
export type ModelFormat = "gguf" | "onnx" | "safetensors" | "mlmodel" | "tensorflowjs" | "coreml";

export interface LocalModel {
  id: string;
  tenantId: string;
  name: string;
  format: ModelFormat;
  sizeBytes: number;
  path: string;
  capabilities: string[];
  quantization?: string;
  contextWindow?: number;
  status: "downloading" | "ready" | "loading" | "running" | "error";
  lastUsed?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EdgeNode {
  id: string;
  tenantId: string;
  name: string;
  target: DeploymentTarget;
  endpoint?: string; // URL for remote edge nodes
  status: "online" | "offline" | "busy" | "error";
  capabilities: NodeCapabilities;
  models: string[]; // model IDs
  lastHeartbeat?: string;
  createdAt: string;
}

export interface NodeCapabilities {
  cpu: { cores: number; architecture: string };
  memory: { totalMb: number; availableMb: number };
  gpu?: { name: string; memoryMb: number; cudaVersion?: string };
  storage: { totalMb: number; availableMb: number };
  network: { bandwidthMbps: number; latencyMs: number };
  supportedFormats: ModelFormat[];
}

export interface InferenceRequest {
  id: string;
  tenantId: string;
  modelId: string;
  nodeId?: string;
  input: string | Record<string, unknown>;
  parameters: Record<string, unknown> | undefined;
  priority: "low" | "normal" | "high" | "critical";
  maxLatencyMs?: number;
  createdAt: string;
}

export interface InferenceResult {
  tenantId: string;
  id: string;
  requestId: string;
  modelId: string;
  nodeId: string;
  output: unknown;
  tokensGenerated: number | undefined;
  latencyMs: number;
  cached: boolean;
  createdAt: string;
}

export interface DataPolicy {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  rules: DataPolicyRule[];
  active: boolean;
  createdAt: string;
}

export interface DataPolicyRule {
  id: string;
  type: "no_cloud" | "encrypt_at_rest" | "encrypt_in_transit" | "data_residency" | "retention" | "anonymize";
  description: string;
  parameters: Record<string, unknown>;
  enforced: boolean;
}

export interface AirGapConfig {
  enabled: boolean;
  allowedEndpoints: string[];
  blockedEndpoints: string[];
  offlineMode: boolean;
  syncStrategy: "manual" | "periodic" | "on_connect";
}

// ─── State ───

interface FederatedState {
  schemaVersion: number;
  models: LocalModel[];
  nodes: EdgeNode[];
  requests: InferenceRequest[];
  results: InferenceResult[];
  dataPolicies: DataPolicy[];
  airGap: AirGapConfig;
}

export class FederatedService {
  private store: DurableJsonState<FederatedState>;

  constructor(private baseDir: string) {
    this.store = new DurableJsonState<FederatedState>(
      join(baseDir, "federated.json"),
      () => ({
        schemaVersion: 1, models: [], nodes: [], requests: [], results: [],
        dataPolicies: [], airGap: { enabled: false, allowedEndpoints: [], blockedEndpoints: [], offlineMode: false, syncStrategy: "on_connect" },
      }),
      (v) => { const s = v as FederatedState; return !!s && s.schemaVersion === 1; },
      "Federated service",
    );
  }

  async init(): Promise<void> { await this.store.read(); }

  // ─── Model Management ───

  async registerModel(tenantId: string, name: string, format: ModelFormat, path: string, capabilities: string[] = []): Promise<LocalModel> {
    const model: LocalModel = {
      id: randomUUID(),
      tenantId,
      name,
      format,
      sizeBytes: 0, // In production, check file size
      path,
      capabilities,
      status: "ready",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    await this.store.mutate(s => { s.models.push(model); });
    return model;
  }

  async getModels(tenantId: string, format?: ModelFormat): Promise<LocalModel[]> {
    const s = await this.store.read();
    return s.models.filter(m => m.tenantId === tenantId && (!format || m.format === format));
  }

  async getModel(id: string): Promise<LocalModel | undefined> {
    const s = await this.store.read();
    return s.models.find(m => m.id === id);
  }

  async loadModel(modelId: string): Promise<void> {
    await this.store.mutate(s => {
      const m = s.models.find(x => x.id === modelId);
      if (m) m.status = "loading";
    });
    // In production, load model into memory
    await this.store.mutate(s => {
      const m = s.models.find(x => x.id === modelId);
      if (m) m.status = "running";
    });
  }

  async unloadModel(modelId: string): Promise<void> {
    await this.store.mutate(s => {
      const m = s.models.find(x => x.id === modelId);
      if (m) m.status = "ready";
    });
  }

  // ─── Edge Node Management ───

  async registerNode(tenantId: string, name: string, target: DeploymentTarget, capabilities: NodeCapabilities): Promise<EdgeNode> {
    const node: EdgeNode = {
      id: randomUUID(),
      tenantId,
      name,
      target,
      status: "online",
      capabilities,
      models: [],
      createdAt: new Date().toISOString(),
    };
    await this.store.mutate(s => { s.nodes.push(node); });
    return node;
  }

  async getNodes(tenantId: string, target?: DeploymentTarget): Promise<EdgeNode[]> {
    const s = await this.store.read();
    return s.nodes.filter(n => n.tenantId === tenantId && (!target || n.target === target));
  }

  async heartbeat(nodeId: string): Promise<void> {
    await this.store.mutate(s => {
      const n = s.nodes.find(x => x.id === nodeId);
      if (n) { n.lastHeartbeat = new Date().toISOString(); n.status = "online"; }
    });
  }

  // ─── Inference ───

  async infer(tenantId: string, modelId: string, input: string | Record<string, unknown>, parameters?: Record<string, unknown>): Promise<InferenceResult> {
    const start = Date.now();

    const request: InferenceRequest = {
      id: randomUUID(),
      tenantId,
      modelId,
      input,
      parameters,
      priority: "normal",
      createdAt: new Date().toISOString(),
    };

    await this.store.mutate(s => { s.requests.push(request); });

    // Find best node for inference
    const node = await this.selectNode(tenantId, modelId);

    // Run inference
    const output = await this.runInference(modelId, node?.id, input, parameters);

    const result: InferenceResult = {
      id: randomUUID(),
      tenantId,
      requestId: request.id,
      modelId,
      nodeId: node?.id ?? "local",
      output,
      tokensGenerated: undefined,
      latencyMs: Date.now() - start,
      cached: false,
      createdAt: new Date().toISOString(),
    };

    await this.store.mutate(s => { s.results.push(result); });
    return result;
  }

  // ─── Data Policies ───

  async createDataPolicy(tenantId: string, name: string, description: string, rules: Omit<DataPolicyRule, "id">[]): Promise<DataPolicy> {
    const policy: DataPolicy = {
      id: randomUUID(),
      tenantId,
      name,
      description,
      rules: rules.map(r => ({ ...r, id: randomUUID() })),
      active: true,
      createdAt: new Date().toISOString(),
    };
    await this.store.mutate(s => { s.dataPolicies.push(policy); });
    return policy;
  }

  async getDataPolicies(tenantId: string): Promise<DataPolicy[]> {
    const s = await this.store.read();
    return s.dataPolicies.filter(p => p.tenantId === tenantId);
  }

  async checkDataPolicy(tenantId: string, operation: string, target: string): Promise<{ allowed: boolean; violations: string[]; unenforceable: string[] }> {
    const policies = await this.getDataPolicies(tenantId);
    const violations: string[] = [];

    // Rule types this method can actually decide. Anything outside this set is
    // reported as unenforceable rather than being silently skipped — an
    // enforced rule that no code evaluates must not read as "compliant".
    const evaluatable = new Set(["no_cloud", "data_residency"]);
    const unenforceable: string[] = [];

    for (const policy of policies.filter(p => p.active)) {
      for (const rule of policy.rules) {
        if (!rule.enforced) continue;

        if (rule.type === "no_cloud" && target.includes("cloud")) {
          violations.push(`Policy "${policy.name}": Cloud access blocked`);
        }
        if (rule.type === "data_residency" && !this.checkResidency(target, rule.parameters)) {
          violations.push(`Policy "${policy.name}": Data residency violation`);
        }
        if (!evaluatable.has(rule.type)) {
          unenforceable.push(`Policy "${policy.name}": rule '${rule.type}' is enforced but not evaluated by checkDataPolicy`);
        }
      }
    }

    return { allowed: violations.length === 0, violations, unenforceable };
  }

  // ─── Air Gap ───

  async configureAirGap(config: Partial<AirGapConfig>): Promise<void> {
    await this.store.mutate(s => {
      Object.assign(s.airGap, config);
    });
  }

  async getAirGapConfig(): Promise<AirGapConfig> {
    const s = await this.store.read();
    return s.airGap;
  }

  async isEndpointAllowed(endpoint: string): Promise<boolean> {
    const config = await this.getAirGapConfig();
    if (!config.enabled) return true;
    if (config.blockedEndpoints.some(e => endpoint.includes(e))) return false;
    if (config.allowedEndpoints.length > 0) return config.allowedEndpoints.some(e => endpoint.includes(e));
    return true;
  }

  // ─── Stats ───

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const models = s.models.filter(m => m.tenantId === tenantId);
    const nodes = s.nodes.filter(n => n.tenantId === tenantId);
    const results = s.results.filter(r => r.tenantId === tenantId);
    return {
      totalModels: models.length,
      runningModels: models.filter(m => m.status === "running").length,
      totalNodes: nodes.length,
      onlineNodes: nodes.filter(n => n.status === "online").length,
      totalInferences: results.length,
      avgLatencyMs: results.length > 0 ? results.reduce((s, r) => s + r.latencyMs, 0) / results.length : 0,
      dataPolicies: s.dataPolicies.filter(p => p.tenantId === tenantId).length,
      airGapEnabled: s.airGap.enabled,
    };
  }

  // ─── Private Helpers ───

  private async selectNode(tenantId: string, modelId: string): Promise<EdgeNode | undefined> {
    const nodes = await this.getNodes(tenantId);
    return nodes.find(n => n.status === "online" && n.models.includes(modelId)) ?? nodes.find(n => n.status === "online");
  }

  /**
   * Local inference is NOT implemented.
   *
   * This returned `{ text: "[Local inference placeholder for model X]" }`,
   * which callers stored and displayed as though it were model output.
   */
  private async runInference(modelId: string, _nodeId: string | undefined, _input: unknown, _parameters?: Record<string, unknown>): Promise<unknown> {
    throw new Error(
      `Local inference for model '${modelId}' is not implemented. ` +
        `It requires a local runtime (llama.cpp, vLLM, or an equivalent) bound to the federated node.`,
    );
  }

  /**
   * Data residency check.
   *
   * This used to `return true` unconditionally, which meant the
   * `data_residency` branch in `checkDataPolicy` could never fire: the rule
   * was configurable, enforceable, and completely inert. A policy engine whose
   * rules cannot fail provides compliance theatre, not compliance.
   *
   * Supported parameters (all optional, combined with AND):
   *   - `allowedRegions: string[]` — the target must match one of these
   *   - `blockedRegions: string[]` — the target must match none of these
   *   - `region: string`           — shorthand for a single allowed region
   *
   * When a rule carries no usable parameters we treat it as UNSATISFIED rather
   * than satisfied: an operator who enables an empty residency rule has
   * misconfigured it, and silently passing would hide that.
   */
  private checkResidency(target: string, params: Record<string, unknown>): boolean {
    const asRegionList = (value: unknown): string[] => {
      if (typeof value === "string") return [value.toLowerCase()];
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase());
      }
      return [];
    };

    const haystack = target.toLowerCase();
    const allowed = [...asRegionList(params["allowedRegions"]), ...asRegionList(params["region"])];
    const blocked = asRegionList(params["blockedRegions"]);

    if (allowed.length === 0 && blocked.length === 0) {
      // Misconfigured rule — surface it as a violation instead of a pass.
      return false;
    }

    const matches = (region: string): boolean => {
      // Match on token boundaries so "eu" does not match "eu-central" only by
      // accident, while still matching "eu-west-1" and "region:eu".
      if (haystack === region) return true;
      return new RegExp(`(^|[^a-z0-9])${region.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(haystack);
    };

    if (blocked.some(matches)) return false;
    if (allowed.length > 0) return allowed.some(matches);
    return true;
  }
}
