import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { join } from "node:path";
import { auroraInteger, auroraText, DurableJsonState } from "../util/aurora-state.js";

const MAX_PUBLISHERS = 200;
const MAX_PINS = 5_000;
const MAX_RECORDS = 20_000;

export type ArtifactKind = "skill" | "plugin" | "microagent";

export interface TrustedPublisher {
  id: string;
  name: string;
  /** Ed25519 public key, SPKI PEM or base64 DER. Nothing else is accepted. */
  publicKey: string;
  addedAt: string;
  addedBy: string;
  note?: string;
}

export interface ArtifactPin {
  kind: ArtifactKind;
  artifactId: string;
  version: string;
  sha256: string;
  pinnedAt: string;
  pinnedBy: string;
  reason?: string;
}

export interface TrustPolicy {
  tenantId: string;
  /** Refuse an artifact without a valid signature from a trusted publisher. */
  requireSignature: boolean;
  /** Refuse an artifact that has no pin. Pinning without this is advisory. */
  requirePin: boolean;
  updatedAt: string;
}

export interface TrustDecision {
  allowed: boolean;
  kind: ArtifactKind;
  artifactId: string;
  version: string;
  sha256: string;
  signatureState: "valid" | "invalid" | "absent" | "unknown-publisher";
  pinState: "matched" | "mismatched" | "absent";
  publisherId?: string;
  reasons: string[];
  at: string;
}

interface TrustStateShape {
  schemaVersion: 1;
  publishers: TrustedPublisher[];
  pins: ArtifactPin[];
  policies: TrustPolicy[];
  decisions: TrustDecision[];
}

/**
 * Supply-chain trust for installable artefacts.
 *
 * The skills hub already verified a bundle's SHA-256 against its index entry, which proves the bytes
 * match what the index said — and nothing about who wrote the index. Two things were missing, and both
 * are the difference between "downloaded the right file" and "installed something we trust":
 *
 * - **Signatures.** A publisher signs the artefact digest with an Ed25519 key registered here by an
 *   administrator. An unsigned artefact, a bad signature, or a signature from an unknown publisher are
 *   three distinct outcomes, reported separately rather than collapsed into "failed".
 * - **Version pinning.** A pin records the exact version and digest a tenant approved. An artefact that
 *   drifts from its pin is refused even if its signature is perfect, because a valid signature on a
 *   different version is exactly what a supply-chain attack looks like.
 *
 * Both are **opt-in per tenant** and default to off, because turning them on without a key registry
 * would break every existing install; `requireSignature` and `requirePin` are the switches, and until
 * they are on the verdict is still computed and recorded so an operator can see what *would* be refused.
 */
export class ManifestTrustService {
  private readonly store: DurableJsonState<TrustStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.store = new DurableJsonState<TrustStateShape>(
      join(rootPath, "security", "manifest-trust.json"),
      () => ({ schemaVersion: 1, publishers: [], pins: [], policies: [], decisions: [] }),
      (value) => {
        const state = value as TrustStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.publishers) && Array.isArray(state.pins)
          && Array.isArray(state.policies) && Array.isArray(state.decisions);
      },
      "Aurora manifest trust",
    );
  }

  async policy(tenantId: string): Promise<TrustPolicy> {
    return await this.store.mutate((state) => structuredClone(this.mutablePolicy(state, tenantId)));
  }

  async configure(input: { tenantId: string; requireSignature?: boolean; requirePin?: boolean }): Promise<TrustPolicy> {
    return await this.store.mutate((state) => {
      const policy = this.mutablePolicy(state, input.tenantId);
      if (input.requireSignature !== undefined) policy.requireSignature = input.requireSignature;
      if (input.requirePin !== undefined) policy.requirePin = input.requirePin;
      policy.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(policy);
    });
  }

  async addPublisher(input: { id: string; name: string; publicKey: string; addedBy?: string; note?: string }): Promise<TrustedPublisher> {
    const id = auroraText(input.id, 100, "Publisher ID").toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,99}$/.test(id)) throw new Error("Publisher ID must be lowercase alphanumeric with dots, dashes or underscores.");
    const publicKey = auroraText(input.publicKey, 8000, "Public key");
    // Refuse anything we cannot actually verify with, at registration time rather than at install time.
    keyOf(publicKey);
    return await this.store.mutate((state) => {
      const publisher: TrustedPublisher = {
        id,
        name: auroraText(input.name, 200, "Publisher name"),
        publicKey,
        addedAt: new Date(this.now()).toISOString(),
        addedBy: auroraText(input.addedBy ?? "operator", 200, "Actor"),
        ...(input.note ? { note: auroraText(input.note, 500, "Note") } : {}),
      };
      const index = state.publishers.findIndex((item) => item.id === id);
      if (index >= 0) state.publishers[index] = publisher;
      else {
        if (state.publishers.length >= MAX_PUBLISHERS) throw new Error(`Publisher registry is limited to ${MAX_PUBLISHERS} entries.`);
        state.publishers.push(publisher);
      }
      return structuredClone(publisher);
    });
  }

  async removePublisher(id: string): Promise<{ id: string; removed: boolean }> {
    const key = id.trim().toLowerCase();
    return await this.store.mutate((state) => {
      const index = state.publishers.findIndex((item) => item.id === key);
      if (index < 0) return { id: key, removed: false };
      state.publishers.splice(index, 1);
      return { id: key, removed: true };
    });
  }

  async publishers(): Promise<Array<Omit<TrustedPublisher, "publicKey"> & { keyDigest: string }>> {
    const state = await this.store.read();
    return state.publishers.map(({ publicKey, ...rest }) => ({
      ...structuredClone(rest),
      keyDigest: createHash("sha256").update(publicKey).digest("hex").slice(0, 32),
    }));
  }

  async pin(input: { kind: ArtifactKind; artifactId: string; version: string; sha256: string; pinnedBy?: string; reason?: string }): Promise<ArtifactPin> {
    const artifactId = auroraText(input.artifactId, 300, "Artifact ID");
    const version = auroraText(input.version, 100, "Version");
    const sha256 = digest(input.sha256);
    return await this.store.mutate((state) => {
      const pin: ArtifactPin = {
        kind: input.kind,
        artifactId,
        version,
        sha256,
        pinnedAt: new Date(this.now()).toISOString(),
        pinnedBy: auroraText(input.pinnedBy ?? "operator", 200, "Actor"),
        ...(input.reason ? { reason: auroraText(input.reason, 500, "Reason") } : {}),
      };
      const index = state.pins.findIndex((item) => item.kind === pin.kind && item.artifactId === pin.artifactId);
      if (index >= 0) state.pins[index] = pin;
      else {
        if (state.pins.length >= MAX_PINS) throw new Error(`The pin registry is limited to ${MAX_PINS} entries.`);
        state.pins.push(pin);
      }
      return structuredClone(pin);
    });
  }

  async unpin(kind: ArtifactKind, artifactId: string): Promise<{ artifactId: string; removed: boolean }> {
    return await this.store.mutate((state) => {
      const index = state.pins.findIndex((item) => item.kind === kind && item.artifactId === artifactId);
      if (index < 0) return { artifactId, removed: false };
      state.pins.splice(index, 1);
      return { artifactId, removed: true };
    });
  }

  async pins(kind?: ArtifactKind): Promise<ArtifactPin[]> {
    const state = await this.store.read();
    return state.pins.filter((item) => (kind ? item.kind === kind : true)).map((item) => structuredClone(item));
  }

  async decisions(limit = 50): Promise<TrustDecision[]> {
    const state = await this.store.read();
    return state.decisions
      .slice(-auroraInteger(limit, 1, 1000, "Decision limit"))
      .reverse()
      .map((item) => structuredClone(item));
  }

  /**
   * Evaluate an artefact. Always returns a verdict and records it; enforcement is the caller's job via
   * `assertInstallable`, so a tenant can watch what would be refused before switching enforcement on.
   */
  async evaluate(input: {
    tenantId: string; kind: ArtifactKind; artifactId: string; version: string; sha256: string;
    signature?: string; publisherId?: string;
  }): Promise<TrustDecision> {
    const state = await this.store.read();
    const policy = state.policies.find((item) => item.tenantId === input.tenantId)
      ?? { tenantId: input.tenantId, requireSignature: false, requirePin: false, updatedAt: new Date(this.now()).toISOString() };
    const sha256 = digest(input.sha256);
    const reasons: string[] = [];

    let signatureState: TrustDecision["signatureState"] = "absent";
    let publisherId: string | undefined;
    if (input.signature) {
      const publisher = state.publishers.find((item) => item.id === (input.publisherId ?? "").trim().toLowerCase());
      if (!publisher) {
        signatureState = "unknown-publisher";
        reasons.push(`Signature references publisher "${input.publisherId ?? "(none)"}", which is not registered.`);
      } else {
        publisherId = publisher.id;
        signatureState = this.check(publisher, `${input.kind}:${input.artifactId}:${input.version}:${sha256}`, input.signature) ? "valid" : "invalid";
        if (signatureState === "invalid") reasons.push(`Signature from "${publisher.id}" does not match the artefact digest.`);
      }
    } else if (policy.requireSignature) {
      reasons.push("No signature was supplied and this tenant requires one.");
    }

    const pin = state.pins.find((item) => item.kind === input.kind && item.artifactId === input.artifactId);
    let pinState: TrustDecision["pinState"] = "absent";
    if (pin) {
      pinState = pin.version === input.version && pin.sha256 === sha256 ? "matched" : "mismatched";
      if (pinState === "mismatched") {
        reasons.push(`Pinned to ${pin.version}/${pin.sha256.slice(0, 12)} but offered ${input.version}/${sha256.slice(0, 12)}.`);
      }
    } else if (policy.requirePin) {
      reasons.push("No pin exists for this artefact and this tenant requires one.");
    }

    const allowed = (!policy.requireSignature || signatureState === "valid")
      && (!policy.requirePin || pinState === "matched")
      && signatureState !== "invalid"
      && pinState !== "mismatched";

    const decision: TrustDecision = {
      allowed,
      kind: input.kind,
      artifactId: input.artifactId,
      version: input.version,
      sha256,
      signatureState,
      pinState,
      ...(publisherId ? { publisherId } : {}),
      reasons,
      at: new Date(this.now()).toISOString(),
    };

    await this.store.mutate((current) => {
      current.decisions.push(decision);
      if (current.decisions.length > MAX_RECORDS) current.decisions.splice(0, current.decisions.length - MAX_RECORDS);
    });
    return decision;
  }

  /** Enforcement wrapper: throws with the reasons when the artefact is not installable. */
  async assertInstallable(input: Parameters<ManifestTrustService["evaluate"]>[0]): Promise<TrustDecision> {
    const decision = await this.evaluate(input);
    if (!decision.allowed) {
      throw new Error(`Artefact "${input.artifactId}" refused by manifest trust: ${decision.reasons.join(" ")}`);
    }
    return decision;
  }

  private check(publisher: TrustedPublisher, payload: string, signature: string): boolean {
    try {
      return verifySignature(null, Buffer.from(payload, "utf8"), keyOf(publisher.publicKey), Buffer.from(signature, "base64"));
    } catch {
      // A malformed signature is invalid, never an exception that takes an install path down.
      return false;
    }
  }

  private mutablePolicy(state: TrustStateShape, tenantId: string): TrustPolicy {
    const id = auroraText(tenantId, 200, "Tenant ID");
    let policy = state.policies.find((item) => item.tenantId === id);
    if (!policy) {
      policy = { tenantId: id, requireSignature: false, requirePin: false, updatedAt: new Date(this.now()).toISOString() };
      state.policies.push(policy);
    }
    return policy;
  }
}

/** The exact string a publisher signs. Exported so a publishing pipeline cannot guess it wrong. */
export function signingPayload(input: { kind: ArtifactKind; artifactId: string; version: string; sha256: string }): string {
  return `${input.kind}:${input.artifactId}:${input.version}:${digest(input.sha256)}`;
}

function keyOf(publicKey: string): ReturnType<typeof createPublicKey> {
  const trimmed = publicKey.trim();
  const key = trimmed.includes("BEGIN")
    ? createPublicKey(trimmed)
    : createPublicKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Only Ed25519 publisher keys are accepted.");
  return key;
}

function digest(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("Artifact digest must be a hex SHA-256.");
  return normalized;
}
