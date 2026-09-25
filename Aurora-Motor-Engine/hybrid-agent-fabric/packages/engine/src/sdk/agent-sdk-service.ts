/**
 * Agent SDK Service
 * Third-party extension framework for securely writing new tools,
 * workflows, expert agents and integrations.
 */

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

// ─── Types ───

export type ExtensionType = "tool" | "workflow" | "agent" | "connector" | "transformer" | "validator";
export type ExtensionStatus = "draft" | "review" | "approved" | "published" | "deprecated" | "revoked";

export interface Extension {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  type: ExtensionType;
  version: string;
  author: string;
  status: ExtensionStatus;
  manifest: ExtensionManifest;
  permissions: ExtensionPermissions;
  /**
   * @deprecated Non-cryptographic marker from before real signing existed.
   * Kept so stored state still loads; `verifySignature` ignores it.
   */
  signature?: string;
  /** The real signature. Absent means unsigned. */
  signatureRecord?: ExtensionSignature;
  publishedAt?: string;
  deprecatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Deterministic JSON: object keys sorted at every depth, no incidental spacing.
 *
 * Not `JSON.stringify(value, sortedKeys)` -- an array replacer filters keys at
 * *every* level, so passing the top-level names silently drops every nested
 * field. A manifest signed that way carries no entrypoint, which means editing
 * the entrypoint does not break the signature. Measured: tampering with
 * `manifest.entrypoint` verified as still-valid under the array form.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * A real signature over an extension.
 *
 * `signature` used to be a `randomUUID()` string and `verifySignature` returned
 * `!!extension.signature` -- so any non-empty string verified, including the
 * random one just written. That is not a signature, it is a boolean dressed up
 * as one. This carries what verification actually needs: which key signed it,
 * what bytes were signed, and the signature itself.
 */
export interface ExtensionSignature {
  /** Identifies the trust-root key, so rotation and revocation are possible. */
  readonly keyId: string;
  readonly algorithm: "ed25519";
  /** SHA-256 (hex) of the canonical payload that was signed. */
  readonly payloadHash: string;
  /** Ed25519 signature over that payload, base64. */
  readonly value: string;
  readonly signedAt: string;
}

/** A public key the platform trusts to sign extensions. */
export interface TrustRootKey {
  readonly keyId: string;
  readonly algorithm: "ed25519";
  /** SubjectPublicKeyInfo PEM. */
  readonly publicKey: string;
  readonly addedAt: string;
  /** Set when the key stops being trusted; signatures made with it then fail. */
  readonly revokedAt?: string | undefined;
}

export interface ExtensionManifest {
  entrypoint: string;
  runtime: "javascript" | "typescript" | "python" | "wasm";
  dependencies: string[];
  config: ExtensionConfig[];
  hooks: ExtensionHook[];
  capabilities: string[];
  minEngineVersion: string;
}

export interface ExtensionConfig {
  key: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  default?: unknown;
  description: string;
}

export interface ExtensionHook {
  event: string;
  handler: string;
  priority: number;
}

export interface ExtensionPermissions {
  filesystem: { read: string[]; write: string[] };
  network: { allowed: string[]; blocked: string[] };
  database: { read: string[]; write: string[] };
  capabilities: string[];
  maxExecutionMs: number;
  maxMemoryMb: number;
}

export interface ExtensionInstance {
  id: string;
  extensionId: string;
  tenantId: string;
  config: Record<string, unknown>;
  status: "active" | "paused" | "error";
  lastExecuted?: string;
  executionCount: number;
  errorCount: number;
  createdAt: string;
}

export interface ExtensionExecution {
  id: string;
  instanceId: string;
  tenantId: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
  status: "success" | "error" | "timeout" | "cancelled";
  startedAt: string;
  completedAt?: string;
}

export interface ExtensionReview {
  id: string;
  extensionId: string;
  reviewer: string;
  rating: number; // 1-5
  comment: string;
  securityScore: number; // 0-100
  approved: boolean;
  findings: ReviewFinding[];
  createdAt: string;
}

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: "security" | "performance" | "quality" | "compatibility";
  description: string;
  recommendation: string;
}

export interface SDKConfig {
  allowUnsigned: boolean;
  maxExtensionsPerTenant: number;
  reviewRequired: boolean;
  sandboxMode: "strict" | "moderate" | "permissive";
  allowedRuntimes: ExtensionManifest["runtime"][];
}

// ─── State ───

interface SDKState {
  schemaVersion: number;
  extensions: Extension[];
  instances: ExtensionInstance[];
  executions: ExtensionExecution[];
  reviews: ExtensionReview[];
  /** Public keys trusted to sign extensions. */
  trustRoots: TrustRootKey[];
  config: SDKConfig;
}

/**
 * Raised when an extension is executed but no sandbox backend exists to run it
 * in. Named so callers can tell "the extension failed" apart from "the platform
 * cannot run extensions at all".
 */
export class ExtensionSandboxUnavailableError extends Error {
  readonly extension: string;

  constructor(extension: string) {
    super(
      `Extension '${extension}' cannot be executed: sandboxed extension execution is not implemented. ` +
        "It requires a real isolate (SandboxExecutor's Worker isolate or the signed WasiPluginManager) " +
        "to be wired into AgentSDKService.",
    );
    this.name = "ExtensionSandboxUnavailableError";
    this.extension = extension;
  }
}

export class AgentSDKService {
  private store: DurableJsonState<SDKState>;

  constructor(private baseDir: string) {
    this.store = new DurableJsonState<SDKState>(
      join(baseDir, "agent-sdk.json"),
      () => ({
        schemaVersion: 1, extensions: [], instances: [], executions: [], reviews: [],
        trustRoots: [],
        config: {
          allowUnsigned: false,
          maxExtensionsPerTenant: 50,
          reviewRequired: true,
          sandboxMode: "strict",
          allowedRuntimes: ["javascript", "typescript", "wasm"],
        },
      }),
      (v) => { const s = v as SDKState; return !!s && s.schemaVersion === 1; },
      "Agent SDK service",
    );
  }

  async init(): Promise<void> { await this.store.read(); }

  // ─── Extension Registration ───

  async registerExtension(tenantId: string, extension: Omit<Extension, "id" | "status" | "createdAt" | "updatedAt">): Promise<Extension> {
    const s = await this.store.read();

    // Check limits
    const tenantExtensions = s.extensions.filter(e => e.tenantId === tenantId);
    if (tenantExtensions.length >= s.config.maxExtensionsPerTenant) {
      throw new Error(`Maximum extensions per tenant reached (${s.config.maxExtensionsPerTenant})`);
    }

    // Check runtime
    if (!s.config.allowedRuntimes.includes(extension.manifest.runtime)) {
      throw new Error(`Runtime "${extension.manifest.runtime}" is not allowed`);
    }

    const newExtension: Extension = {
      ...extension,
      id: randomUUID(),
      status: s.config.reviewRequired ? "draft" : "approved",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.store.mutate(s => { s.extensions.push(newExtension); });
    return newExtension;
  }

  async getExtensions(tenantId: string, type?: ExtensionType, status?: ExtensionStatus): Promise<Extension[]> {
    const s = await this.store.read();
    return s.extensions.filter(e =>
      e.tenantId === tenantId &&
      (!type || e.type === type) &&
      (!status || e.status === status)
    );
  }

  async getExtension(id: string): Promise<Extension | undefined> {
    const s = await this.store.read();
    return s.extensions.find(e => e.id === id);
  }

  async updateExtensionStatus(extensionId: string, status: ExtensionStatus): Promise<void> {
    await this.store.mutate(s => {
      const e = s.extensions.find(x => x.id === extensionId);
      if (e) {
        e.status = status;
        e.updatedAt = new Date().toISOString();
        if (status === "published") e.publishedAt = new Date().toISOString();
        if (status === "deprecated") e.deprecatedAt = new Date().toISOString();
      }
    });
  }

  // ─── Instance Management ───

  async createInstance(extensionId: string, tenantId: string, config: Record<string, unknown> = {}): Promise<ExtensionInstance> {
    const extension = await this.getExtension(extensionId);
    if (!extension) throw new Error(`Extension not found: ${extensionId}`);
    if (extension.status !== "published" && extension.status !== "approved") {
      throw new Error(`Extension is not in a runnable state: ${extension.status}`);
    }

    // Validate config against manifest
    this.validateConfig(config, extension.manifest.config);

    const instance: ExtensionInstance = {
      id: randomUUID(),
      extensionId,
      tenantId,
      config,
      status: "active",
      executionCount: 0,
      errorCount: 0,
      createdAt: new Date().toISOString(),
    };

    await this.store.mutate(s => { s.instances.push(instance); });
    return instance;
  }

  async getInstances(tenantId: string, extensionId?: string): Promise<ExtensionInstance[]> {
    const s = await this.store.read();
    return s.instances.filter(i => i.tenantId === tenantId && (!extensionId || i.extensionId === extensionId));
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await this.store.mutate(s => {
      s.instances = s.instances.filter(i => i.id !== instanceId);
    });
  }

  // ─── Execution ───

  async execute(instanceId: string, tenantId: string, input: unknown): Promise<ExtensionExecution> {
    const s = await this.store.read();
    const instance = s.instances.find(i => i.id === instanceId && i.tenantId === tenantId);
    if (!instance) throw new Error(`Instance not found: ${instanceId}`);
    if (instance.status !== "active") throw new Error(`Instance is not active: ${instance.status}`);

    const extension = s.extensions.find(e => e.id === instance.extensionId);
    if (!extension) throw new Error(`Extension not found`);

    const start = Date.now();
    const execution: ExtensionExecution = {
      id: randomUUID(),
      instanceId,
      tenantId,
      input,
      // Starts as an error: nothing has run yet, so there is nothing to call a
      // success. Only a completed sandbox run may downgrade this.
      status: "error",
      durationMs: 0,
      startedAt: new Date().toISOString(),
    };

    try {
      // Execute in sandbox
      const output = await this.executeInSandbox(extension, instance, input);
      execution.output = output;
      execution.status = "success";
    } catch (err: unknown) {
      execution.error = err instanceof Error ? err.message : String(err);
      execution.status = "error";
    }

    execution.durationMs = Date.now() - start;
    execution.completedAt = new Date().toISOString();

    await this.store.mutate(s => {
      s.executions.push(execution);
      const inst = s.instances.find(i => i.id === instanceId);
      if (inst) {
        inst.executionCount++;
        inst.lastExecuted = new Date().toISOString();
        if (execution.status === "error") inst.errorCount++;
      }
    });

    return execution;
  }

  async getExecutions(tenantId: string, instanceId?: string, limit: number = 50): Promise<ExtensionExecution[]> {
    const s = await this.store.read();
    return s.executions
      .filter(e => e.tenantId === tenantId && (!instanceId || e.instanceId === instanceId))
      .slice(-limit);
  }

  // ─── Reviews ───

  async submitReview(extensionId: string, review: Omit<ExtensionReview, "id" | "createdAt">): Promise<ExtensionReview> {
    const newReview: ExtensionReview = {
      ...review,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };

    await this.store.mutate(s => { s.reviews.push(newReview); });

    // Auto-approve if security score is high enough
    if (review.approved && review.securityScore >= 80) {
      await this.updateExtensionStatus(extensionId, "approved");
    }

    return newReview;
  }

  async getReviews(extensionId: string): Promise<ExtensionReview[]> {
    const s = await this.store.read();
    return s.reviews.filter(r => r.extensionId === extensionId);
  }

  // ─── SDK Config ───

  async getConfig(): Promise<SDKConfig> {
    const s = await this.store.read();
    return s.config;
  }

  async updateConfig(config: Partial<SDKConfig>): Promise<void> {
    await this.store.mutate(s => { Object.assign(s.config, config); });
  }

  // ─── Signing ───

  /**
   * Deterministic bytes that a signature covers.
   *
   * Every field that changes what the extension *does* is included, and the
   * serialisation is canonical (keys sorted, no incidental whitespace) so two
   * processes hashing the same extension get the same digest. Sign the object as
   * it happened to be laid out in memory and the signature breaks on the first
   * reformat.
   */
  private canonicalPayload(extension: Extension): Buffer {
    const signed = {
      id: extension.id,
      tenantId: extension.tenantId,
      name: extension.name,
      version: extension.version,
      author: extension.author,
      type: extension.type,
      manifest: extension.manifest,
      permissions: extension.permissions,
    };
    return Buffer.from(canonicalJson(signed), "utf8");
  }

  /**
   * Create an Ed25519 signing key and register its public half as a trust root.
   *
   * The private key is returned once and never stored: a platform that keeps the
   * signing key next to the signatures it produced cannot prove anything to
   * anyone, including itself.
   */
  async generateSigningKey(label: string): Promise<{ keyId: string; privateKey: string; publicKey: string }> {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const keyId = randomUUID();
    await this.store.mutate(s => {
      s.trustRoots.push({
        keyId,
        algorithm: "ed25519",
        publicKey: publicPem,
        addedAt: new Date().toISOString(),
      });
    });
    void label;
    return {
      keyId,
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKey: publicPem,
    };
  }

  /** Register an externally generated public key as a trust root. */
  async addTrustRoot(publicKeyPem: string): Promise<string> {
    // Reject anything that is not a usable Ed25519 key rather than storing a
    // string that only fails later, at verification time.
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error(`Trust root must be an Ed25519 key, got ${key.asymmetricKeyType}.`);
    }
    const keyId = randomUUID();
    await this.store.mutate(s => {
      s.trustRoots.push({
        keyId,
        algorithm: "ed25519",
        publicKey: publicKeyPem,
        addedAt: new Date().toISOString(),
      });
    });
    return keyId;
  }

  /** Stop trusting a key. Signatures made with it stop verifying immediately. */
  async revokeSigningKey(keyId: string): Promise<void> {
    await this.store.mutate(s => {
      const key = s.trustRoots.find(k => k.keyId === keyId);
      if (!key) throw new Error(`Unknown signing key: ${keyId}`);
      (key as { revokedAt?: string }).revokedAt = new Date().toISOString();
    });
  }

  /**
   * Sign an extension with a private key.
   *
   * The key's public half must already be a trust root, otherwise the platform
   * would be storing signatures it has no way to check.
   */
  async signExtension(extensionId: string, privateKeyPem: string): Promise<ExtensionSignature> {
    const extension = await this.getExtension(extensionId);
    if (!extension) throw new Error(`Unknown extension: ${extensionId}`);

    const payload = this.canonicalPayload(extension);
    // One-shot sign with a null algorithm: Ed25519 has no digest to choose, and
    // the streaming createSign() API does not accept that.
    const value = cryptoSign(null, payload, privateKeyPem).toString("base64");

    // Which trust root does this key belong to? Deriving the public key from the
    // private one is how the signature stays attributable without the caller
    // having to pass a key id that could be wrong.
    const publicPem = createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
    const state = await this.store.read();
    const trustRoot = state.trustRoots.find(k => k.publicKey === publicPem);
    if (!trustRoot) {
      throw new Error(
        "This key is not a registered trust root. Register its public key with " +
          "addTrustRoot() before signing, or the signature cannot be verified.",
      );
    }
    // Signing with a revoked key would produce a signature that verification
    // then rejects, which reads as a mysterious failure later. Refuse now.
    if (trustRoot.revokedAt) {
      throw new Error(`Signing key ${trustRoot.keyId} was revoked at ${trustRoot.revokedAt}.`);
    }

    const record: ExtensionSignature = {
      keyId: trustRoot.keyId,
      algorithm: "ed25519",
      payloadHash: createHash("sha256").update(payload).digest("hex"),
      value,
      signedAt: new Date().toISOString(),
    };
    await this.store.mutate(s => {
      const e = s.extensions.find(x => x.id === extensionId);
      if (e) {
        e.signatureRecord = record;
        // Clear the legacy marker so nothing can mistake it for a signature.
        delete e.signature;
      }
    });
    return record;
  }

  /**
   * Verify an extension's signature cryptographically.
   *
   * Returns true only when a registered, non-revoked trust-root key really did
   * sign the extension's current contents. An edited extension fails, because
   * the payload no longer hashes to what was signed -- that is the point.
   */
  async verifySignature(extensionId: string): Promise<boolean> {
    const extension = await this.getExtension(extensionId);
    if (!extension) return false;

    const record = extension.signatureRecord;
    if (!record) {
      const config = await this.getConfig();
      // Explicit opt-out, not the default. The default is "unsigned does not verify".
      return config.allowUnsigned;
    }

    const state = await this.store.read();
    const trustRoot = state.trustRoots.find(k => k.keyId === record.keyId);
    if (!trustRoot) return false;
    if (trustRoot.revokedAt) return false;

    const payload = this.canonicalPayload(extension);
    if (createHash("sha256").update(payload).digest("hex") !== record.payloadHash) return false;

    try {
      return cryptoVerify(null, payload, trustRoot.publicKey, Buffer.from(record.value, "base64"));
    } catch {
      // A malformed signature is a failed verification, not a crash.
      return false;
    }
  }

  // ─── Stats ───

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const extensions = s.extensions.filter(e => e.tenantId === tenantId);
    const instances = s.instances.filter(i => i.tenantId === tenantId);
    const executions = s.executions.filter(e => e.tenantId === tenantId);
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const e of extensions) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    }
    return {
      totalExtensions: extensions.length,
      totalInstances: instances.length,
      totalExecutions: executions.length,
      byType,
      byStatus,
      successRate: executions.length > 0 ? executions.filter(e => e.status === "success").length / executions.length : 0,
      avgDurationMs: executions.length > 0 ? executions.reduce((s, e) => s + e.durationMs, 0) / executions.length : 0,
    };
  }

  // ─── Private Helpers ───

  private validateConfig(config: Record<string, unknown>, schema: ExtensionConfig[]): void {
    for (const field of schema) {
      if (field.required && !(field.key in config)) {
        throw new Error(`Required config field missing: ${field.key}`);
      }
    }
  }

  /**
   * Extension execution — deliberately NOT implemented.
   *
   * This used to return `{ success: true, extension, input }` without running
   * anything. The consequences compounded: the caller recorded
   * `status: "success"`, and `stats()` then divided successes by executions, so
   * an extension that had never executed reported a **100% success rate**. A
   * fabricated metric is worse than a missing one, because it is trusted.
   *
   * Running untrusted extension code needs a real isolate. The engine already
   * has two — `SandboxExecutor` (Worker isolate, V8 resourceLimits) and
   * `WasiPluginManager` (signed, out-of-process). Wiring one of them here is
   * the work; echoing the input is not.
   *
   * When that lands, replace this body — do not delete the guard.
   */
  private async executeInSandbox(extension: Extension, _instance: ExtensionInstance, _input: unknown): Promise<unknown> {
    throw new ExtensionSandboxUnavailableError(extension.name);
  }
}
