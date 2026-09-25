import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { atomicWrite } from "../util/atomic-file.js";
import type { JsonValue } from "../types.js";

export interface InteractiveArtifactRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  name: string;
  sourcePath: string;
  sha256: string;
  bytes: number;
  allowedActions: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ArtifactInteractionRecord {
  id: string;
  artifactId: string;
  tenantId: string;
  sessionId: string;
  action: string;
  payloadSha256: string;
  status: "received" | "delivered" | "failed" | "uncertain";
  responseSha256?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}
interface RegistryState { schemaVersion: 1; artifacts: InteractiveArtifactRecord[]; interactions: ArtifactInteractionRecord[] }
interface FrameGrant { channel: string; artifactId: string; tenantId: string; sessionId: string; expiresAt: number; remaining: number }

export class InteractiveArtifactRegistry {
  private state: RegistryState = { schemaVersion: 1, artifacts: [], interactions: [] };
  private loaded = false;
  private readonly grants = new Map<string, FrameGrant>();
  constructor(private readonly rootPath: string) {}

  async publish(input: { tenantId: string; sessionId: string; workspacePath: string; name: string; sourcePath: string; allowedActions: string[] }): Promise<InteractiveArtifactRecord> {
    await this.load();
    const name = input.name.trim();
    if (!name || name.length > 200) throw new Error("Interactive artifact name is invalid.");
    const allowedActions = [...new Set(input.allowedActions.map(actionName))];
    if (!allowedActions.length || allowedActions.length > 32) throw new Error("Interactive artifact requires 1 to 32 allowed actions.");
    const source = await readSource(input.workspacePath, input.sourcePath);
    const now = new Date().toISOString();
    const record: InteractiveArtifactRecord = {
      id: randomUUID(), tenantId: input.tenantId, sessionId: input.sessionId, name,
      sourcePath: source.relativePath, sha256: source.sha256, bytes: source.bytes.length,
      allowedActions, enabled: true, createdAt: now, updatedAt: now,
    };
    this.state.artifacts.push(record); await this.save(); return structuredClone(record);
  }

  async list(tenantId: string, sessionId?: string): Promise<InteractiveArtifactRecord[]> {
    await this.load(); return this.state.artifacts.filter(item => item.tenantId === tenantId && (!sessionId || item.sessionId === sessionId)).map(item => structuredClone(item));
  }
  async get(id: string, tenantId: string): Promise<InteractiveArtifactRecord> {
    await this.load(); const record = this.state.artifacts.find(item => item.id === id && item.tenantId === tenantId);
    if (!record) throw new Error("Interactive artifact not found in tenant."); return structuredClone(record);
  }
  async setEnabled(id: string, tenantId: string, enabled: boolean): Promise<InteractiveArtifactRecord> {
    await this.load(); const record = this.state.artifacts.find(item => item.id === id && item.tenantId === tenantId);
    if (!record) throw new Error("Interactive artifact not found in tenant.");
    record.enabled = enabled; record.updatedAt = new Date().toISOString();
    if (!enabled) for (const [channel, grant] of this.grants) if (grant.artifactId === id) this.grants.delete(channel);
    await this.save(); return structuredClone(record);
  }
  async remove(id: string, tenantId: string): Promise<boolean> {
    await this.load(); const before = this.state.artifacts.length;
    this.state.artifacts = this.state.artifacts.filter(item => !(item.id === id && item.tenantId === tenantId));
    if (before === this.state.artifacts.length) return false;
    for (const [channel, grant] of this.grants) if (grant.artifactId === id) this.grants.delete(channel);
    await this.save(); return true;
  }

  async createFrame(input: { id: string; tenantId: string; sessionId: string }): Promise<{ channel: string; expiresAt: string }> {
    const artifact = await this.get(input.id, input.tenantId);
    if (!artifact.enabled || artifact.sessionId !== input.sessionId) throw new Error("Interactive artifact is disabled or session-scoped elsewhere.");
    this.purgeGrants();
    if (this.grants.size >= 1000) throw new Error("Interactive artifact frame grant limit reached.");
    const channel = randomBytes(32).toString("base64url"), expiresAt = Date.now() + 15 * 60_000;
    this.grants.set(channel, { channel, artifactId: artifact.id, tenantId: artifact.tenantId, sessionId: artifact.sessionId, expiresAt, remaining: 100 });
    return { channel, expiresAt: new Date(expiresAt).toISOString() };
  }

  async renderFrame(input: { id: string; tenantId: string; sessionId: string; workspacePath: string; channel: string }): Promise<string> {
    const grant = this.grant(input.channel, input.id, input.tenantId, input.sessionId, false);
    const artifact = await this.get(input.id, input.tenantId);
    if (!artifact.enabled || grant.artifactId !== artifact.id) throw new Error("Interactive artifact frame grant is invalid.");
    const source = await readSource(input.workspacePath, artifact.sourcePath);
    if (source.sha256 !== artifact.sha256 || source.bytes.length !== artifact.bytes) throw new Error("Interactive artifact source changed after publication; republish it.");
    const html = source.bytes.toString("utf8").replace(/^\s*<!doctype[^>]*>/i, "");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>${bridgeScript(input.channel)}</script></head><body>${html}</body></html>`;
  }

  async acceptInteraction(input: { artifactId: string; tenantId: string; sessionId: string; channel: string; interactionId: string; action: string; payload: JsonValue }): Promise<{ interaction: ArtifactInteractionRecord; prompt: string; duplicate: boolean }> {
    await this.load();
    const grant = this.grant(input.channel, input.artifactId, input.tenantId, input.sessionId, true);
    const artifact = await this.get(input.artifactId, input.tenantId);
    const action = actionName(input.action);
    if (!artifact.allowedActions.includes(action)) throw new Error("Interactive artifact action is not allowlisted.");
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(input.interactionId)) throw new Error("Interactive artifact interaction id is invalid.");
    validatePayload(input.payload);
    const payloadText = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadText) > 64 * 1024) throw new Error("Interactive artifact payload exceeds 64 KiB.");
    const existing = this.state.interactions.find(item => item.id === input.interactionId && item.tenantId === input.tenantId);
    if (existing) return { interaction: structuredClone(existing), prompt: "", duplicate: true };
    const now = new Date().toISOString();
    const interaction: ArtifactInteractionRecord = {
      id: input.interactionId, artifactId: artifact.id, tenantId: artifact.tenantId, sessionId: artifact.sessionId,
      action, payloadSha256: sha256(payloadText), status: "received", createdAt: now, updatedAt: now,
    };
    this.state.interactions.push(interaction); grant.remaining--; await this.save();
    const prompt = `<INTERACTIVE_ARTIFACT_EVENT untrusted="true" artifact=${JSON.stringify(artifact.name)} action=${JSON.stringify(action)}>\n${payloadText}\n</INTERACTIVE_ARTIFACT_EVENT>\nRespond to the widget interaction. Use governed tools only when necessary.`;
    return { interaction: structuredClone(interaction), prompt, duplicate: false };
  }

  async completeInteraction(id: string, tenantId: string, outcome: { status: "delivered" | "failed" | "uncertain"; response?: string; errorCode?: string }): Promise<ArtifactInteractionRecord> {
    await this.load(); const item = this.state.interactions.find(value => value.id === id && value.tenantId === tenantId);
    if (!item) throw new Error("Interactive artifact interaction is missing.");
    item.status = outcome.status; item.updatedAt = new Date().toISOString();
    if (outcome.response !== undefined) item.responseSha256 = sha256(outcome.response);
    if (outcome.errorCode) item.errorCode = outcome.errorCode.slice(0, 100);
    await this.save(); return structuredClone(item);
  }
  async interactions(tenantId: string, sessionId: string): Promise<ArtifactInteractionRecord[]> {
    await this.load(); return this.state.interactions.filter(item => item.tenantId === tenantId && item.sessionId === sessionId).slice(-1000).map(item => structuredClone(item));
  }

  private grant(channel: string, artifactId: string, tenantId: string, sessionId: string, requireRemaining: boolean): FrameGrant {
    this.purgeGrants();
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(channel)) throw new Error("Interactive artifact frame channel is invalid.");
    const grant = this.grants.get(channel);
    if (!grant || grant.artifactId !== artifactId || grant.tenantId !== tenantId || grant.sessionId !== sessionId || (requireRemaining && grant.remaining <= 0)) throw new Error("Interactive artifact frame grant is missing or expired.");
    return grant;
  }
  private purgeGrants(): void { for (const [key, grant] of this.grants) if (grant.expiresAt <= Date.now() || grant.remaining <= 0) this.grants.delete(key); }
  private get path(): string { return join(this.rootPath, "artifacts", "interactive.json"); }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8"); if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error("Interactive artifact registry exceeds 16 MiB.");
      const parsed = JSON.parse(raw) as RegistryState; if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.artifacts) || !Array.isArray(parsed.interactions)) throw new Error("Interactive artifact registry is malformed.");
      this.state = parsed;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.loaded = true;
  }
  private async save(): Promise<void> {
    if (this.state.interactions.length > 100_000) this.state.interactions.splice(0, this.state.interactions.length - 100_000);
    const encoded = `${JSON.stringify(this.state, null, 2)}\n`; if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new Error("Interactive artifact registry exceeds 16 MiB.");
    await atomicWrite(this.path, encoded);
  }
}

async function readSource(workspacePath: string, requested: string) {
  const root = await realpath(workspacePath), source = await realpath(resolve(root, requested)), rel = relative(root, source);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Interactive artifact source escapes the workspace.");
  if (!/\.html?$/i.test(source)) throw new Error("Interactive artifact source must be HTML.");
  const bytes = await readFile(source);
  if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) throw new Error("Interactive artifact source must be non-empty UTF-8 HTML under 2 MiB.");
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes) !== 0) throw new Error("Interactive artifact source is not valid UTF-8.");
  return { bytes, relativePath: rel.split(sep).join("/"), sha256: sha256(bytes) };
}
function actionName(value: string): string {
  const action = value.trim(); if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(action)) throw new Error("Interactive artifact action name is invalid."); return action;
}
function validatePayload(value: JsonValue, depth = 0): void {
  if (depth > 8) throw new Error("Interactive artifact payload nesting exceeds 8 levels.");
  if (Array.isArray(value)) { if (value.length > 1000) throw new Error("Interactive artifact payload array is too large."); for (const item of value) validatePayload(item, depth + 1); return; }
  if (value && typeof value === "object") {
    const entries = Object.entries(value); if (entries.length > 1000) throw new Error("Interactive artifact payload object is too large.");
    for (const [key, item] of entries) { if (["__proto__", "prototype", "constructor"].includes(key) || key.length > 200) throw new Error("Interactive artifact payload key is invalid."); validatePayload(item, depth + 1); }
  }
}
function bridgeScript(channel: string): string {
  return `(()=>{const channel=${JSON.stringify(channel)};const pending=new Map();const send=(action,payload)=>{const interactionId=crypto.randomUUID();parent.postMessage({hafArtifact:true,channel,interactionId,action,payload},'*');return interactionId};const request=(action,payload)=>new Promise((resolve,reject)=>{const interactionId=send(action,payload);pending.set(interactionId,{resolve,reject});setTimeout(()=>{if(pending.delete(interactionId))reject(new Error('Artifact interaction timed out'))},120000)});Object.defineProperty(window,'hafArtifact',{value:Object.freeze({emit:send,request}),writable:false,configurable:false});addEventListener('message',event=>{const data=event.data;if(!data||data.hafArtifactResult!==true||data.channel!==channel)return;const item=pending.get(data.interactionId);if(!item)return;pending.delete(data.interactionId);data.ok?item.resolve(data.result):item.reject(new Error(data.error||'Artifact interaction failed'))});parent.postMessage({hafArtifactReady:true,channel},'*')})();`;
}
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
