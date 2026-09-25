import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { InputSource, SessionAgentProfile } from "../types.js";
import type { Supervisor } from "../runtime/supervisor.js";
import { atomicWrite } from "../util/atomic-file.js";

export interface InboundChannelMessage {
  tenantId: string;
  platform: string;
  chatId: string;
  chatType: "dm" | "group" | "channel" | "thread";
  userId: string;
  text: string;
  threadId?: string;
  messageId?: string;
  authorized: boolean;
  metadata?: Record<string, string>;
}

export interface ChannelRoute {
  key: string;
  tenantId: string;
  platform: string;
  chatIdHash: string;
  sessionId: string;
  routingRuleId?: string;
  agentProfileId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelRoutingRule {
  id: string;
  tenantId: string;
  name: string;
  priority: number;
  enabled: boolean;
  platforms: string[];
  chatTypes: InboundChannelMessage["chatType"][];
  chatIdHashes: string[];
  userIdHashes: string[];
  metadataEquals: Record<string, string>;
  sessionScope: "chat" | "user" | "thread";
  agentProfileId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelDelivery {
  sessionId: string;
  commandId: string;
  text: string;
  status: "completed" | "rejected" | "uncertain";
}

export interface ChannelGatewayOptions {
  resolveAgentProfile?: (profileId: string, tenantId: string) => Promise<SessionAgentProfile>;
  /** P1.49: called after an authorized inbound message was routed; used for proactive intake. */
  onIngested?: (message: InboundChannelMessage) => void | Promise<void>;
}

function sourceFor(platform: string): InputSource {
  return (["telegram", "discord", "slack"] as string[]).includes(platform)
    ? (platform as InputSource)
    : "webhook";
}

function opaque(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function validPlatform(value: string): string {
  const platform = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(platform)) throw new Error(`Invalid channel platform: ${value}`);
  return platform;
}

export class ChannelGateway {
  private routes: ChannelRoute[] = [];
  private rules: ChannelRoutingRule[] = [];
  private loaded = false;

  constructor(
    private readonly rootPath: string,
    private readonly supervisor: Supervisor,
    private readonly options: ChannelGatewayOptions = {},
  ) {}

  private get path(): string { return join(this.rootPath, "channels", "routes.json"); }
  private get rulesPath(): string { return join(this.rootPath, "channels", "routing-rules.json"); }

  private key(message: InboundChannelMessage, rule?: ChannelRoutingRule): string {
    const scope = rule?.sessionScope ?? (message.threadId ? "thread" : message.chatType === "dm" ? "user" : "chat");
    const lane = scope === "thread" ? message.threadId || message.chatId : scope === "user" ? message.userId : message.chatId;
    return `${message.tenantId}:${message.platform}:${rule?.id ?? "default"}:${scope}:${opaque(lane)}`;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.routes = Array.isArray(parsed) ? parsed as ChannelRoute[] : [];
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      const parsed = JSON.parse(await readFile(this.rulesPath, "utf8")) as unknown;
      this.rules = Array.isArray(parsed) ? parsed as ChannelRoutingRule[] : [];
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.loaded = true;
  }

  private async saveRoutes(): Promise<void> { await atomicWrite(this.path, `${JSON.stringify(this.routes, null, 2)}\n`); }
  private async saveRules(): Promise<void> { await atomicWrite(this.rulesPath, `${JSON.stringify(this.rules, null, 2)}\n`); }

  private matchingRule(message: InboundChannelMessage): ChannelRoutingRule | undefined {
    const chatHash = opaque(message.chatId); const userHash = opaque(message.userId);
    return this.rules
      .filter((rule) => rule.enabled && rule.tenantId === message.tenantId)
      .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))
      .find((rule) =>
        (!rule.platforms.length || rule.platforms.includes(message.platform)) &&
        (!rule.chatTypes.length || rule.chatTypes.includes(message.chatType)) &&
        (!rule.chatIdHashes.length || rule.chatIdHashes.includes(chatHash)) &&
        (!rule.userIdHashes.length || rule.userIdHashes.includes(userHash)) &&
        Object.entries(rule.metadataEquals).every(([key, value]) => message.metadata?.[key] === value));
  }

  async ingest(message: InboundChannelMessage): Promise<ChannelDelivery> {
    if (!message.authorized) throw new Error("Channel sender is not authorized or paired.");
    if (!message.text.trim()) throw new Error("Channel message text is empty.");
    await this.load();
    const rule = this.matchingRule(message);
    const key = this.key(message, rule);
    let route = this.routes.find((item) => item.key === key);
    if (!route) {
      const agentProfile = rule?.agentProfileId && this.options.resolveAgentProfile
        ? await this.options.resolveAgentProfile(rule.agentProfileId, message.tenantId)
        : undefined;
      const session = await this.supervisor.createSession({
        tenantId: message.tenantId,
        name: `${message.platform}-${message.chatType}-${opaque(message.chatId).slice(0, 8)}`,
        ...(agentProfile ? { agentProfile } : {}),
      });
      const now = new Date().toISOString();
      route = {
        key, tenantId: message.tenantId, platform: message.platform,
        chatIdHash: opaque(message.chatId), sessionId: session.sessionId,
        ...(rule ? { routingRuleId: rule.id } : {}),
        ...(agentProfile ? { agentProfileId: agentProfile.id } : {}),
        createdAt: now, updatedAt: now,
      };
      this.routes.push(route); await this.saveRoutes();
    }
    const commandId = message.messageId ? `channel:${message.platform}:${message.messageId}` : randomUUID();
    const result = await this.supervisor.dispatch({
      protocolVersion: 1,
      commandId,
      clientId: `channel:${message.platform}:${opaque(message.chatId)}`,
      tenantId: message.tenantId,
      sessionId: route.sessionId,
      kind: "session.prompt",
      source: sourceFor(message.platform),
      issuedAt: new Date().toISOString(),
      payload: {
        text: message.text,
        channelContext: {
          platform: message.platform,
          chatType: message.chatType,
          userIdHash: opaque(message.userId),
          ...(route.routingRuleId ? { routingRuleId: route.routingRuleId } : {}),
          ...(message.metadata ?? {}),
        },
      },
    });
    route.updatedAt = new Date().toISOString(); await this.saveRoutes();
    try {
      await this.options.onIngested?.(message);
    } catch {
      // Intake is an observer of the gateway, never a participant.
    }
    const payload = result.result as { finalText?: unknown } | undefined;
    return {
      sessionId: route.sessionId,
      commandId,
      text: typeof payload?.finalText === "string" ? payload.finalText : result.error?.message ?? "",
      status: result.status,
    };
  }

  async listRoutes(tenantId?: string): Promise<ChannelRoute[]> {
    await this.load(); return this.routes.filter((route) => !tenantId || route.tenantId === tenantId).map((route) => structuredClone(route));
  }

  async listRoutingRules(tenantId: string): Promise<ChannelRoutingRule[]> {
    await this.load(); return this.rules.filter((rule) => rule.tenantId === tenantId).sort((a, b) => b.priority - a.priority).map((rule) => structuredClone(rule));
  }

  async addRoutingRule(input: {
    tenantId: string;
    name: string;
    priority?: number;
    platforms?: string[];
    chatTypes?: InboundChannelMessage["chatType"][];
    chatIds?: string[];
    userIds?: string[];
    metadataEquals?: Record<string, string>;
    sessionScope?: ChannelRoutingRule["sessionScope"];
    agentProfileId?: string;
  }): Promise<ChannelRoutingRule> {
    await this.load();
    const name = input.name.trim(); if (!name || name.length > 200) throw new Error("Channel routing-rule name is invalid.");
    if (input.agentProfileId && this.options.resolveAgentProfile) await this.options.resolveAgentProfile(input.agentProfileId, input.tenantId);
    const metadataEquals: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.metadataEquals ?? {})) {
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key) || typeof value !== "string" || value.length > 500) throw new Error("Channel routing metadata matcher is invalid.");
      metadataEquals[key] = value;
    }
    const now = new Date().toISOString();
    const rule: ChannelRoutingRule = {
      id: randomUUID(), tenantId: input.tenantId, name,
      priority: Math.max(-10000, Math.min(10000, Math.floor(input.priority ?? 0))), enabled: true,
      platforms: [...new Set((input.platforms ?? []).map(validPlatform))].slice(0, 50),
      chatTypes: [...new Set(input.chatTypes ?? [])].slice(0, 4),
      chatIdHashes: [...new Set((input.chatIds ?? []).map(opaque))].slice(0, 500),
      userIdHashes: [...new Set((input.userIds ?? []).map(opaque))].slice(0, 500),
      metadataEquals,
      sessionScope: input.sessionScope ?? "chat",
      ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
      createdAt: now, updatedAt: now,
    };
    this.rules.push(rule); await this.saveRules(); return structuredClone(rule);
  }

  async setRoutingRuleEnabled(id: string, tenantId: string, enabled: boolean): Promise<ChannelRoutingRule> {
    await this.load(); const rule = this.rules.find((item) => item.id === id && item.tenantId === tenantId);
    if (!rule) throw new Error("Channel routing rule not found in tenant.");
    rule.enabled = enabled; rule.updatedAt = new Date().toISOString(); await this.saveRules(); return structuredClone(rule);
  }

  async removeRoutingRule(id: string, tenantId: string): Promise<boolean> {
    await this.load(); const before = this.rules.length;
    this.rules = this.rules.filter((rule) => !(rule.id === id && rule.tenantId === tenantId));
    if (before !== this.rules.length) await this.saveRules(); return before !== this.rules.length;
  }
}
