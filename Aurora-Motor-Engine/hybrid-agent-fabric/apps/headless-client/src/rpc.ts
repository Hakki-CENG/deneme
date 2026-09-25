import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { HafApiClient, HafApiError } from "./client.js";

/**
 * Client identity reported in the JSON-RPC `initialize` handshake.
 *
 * This was hardcoded to "1.38.0", so every peer talking to this client was told
 * it was negotiating with a release 27 versions old. `../package.json` resolves
 * to the app root from both `src/` and `dist/`.
 */
const CLIENT_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version ?? "0.0.0-unknown";

export interface JsonRpcRequest { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown }
export interface JsonRpcResponse { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export class HeadlessRpcServer {
  private readonly subscriptions = new Map<string, AbortController>();
  private closed = false;

  constructor(private readonly client: HafApiClient, private readonly emit: (message: unknown) => void) {}

  async handleLine(line: string): Promise<void> {
    if (Buffer.byteLength(line) > 1024 * 1024) return this.emit(errorResponse(null, -32700, "JSON-RPC line exceeds 1 MiB."));
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { return this.emit(errorResponse(null, -32700, "Parse error.")); }
    if (!isRequest(value)) return this.emit(errorResponse(requestId(value), -32600, "Invalid Request."));
    const response = await this.handle(value);
    if (response && value.id !== undefined) this.emit(response);
  }

  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    if (this.closed && request.method !== "shutdown") return errorResponse(request.id ?? null, -32000, "RPC server is closed.");
    try {
      const params = objectParams(request.params);
      let result: unknown;
      switch (request.method) {
        case "initialize":
          result = { protocolVersion: 1, clientInfo: { name: "haf-headless-client", version: CLIENT_VERSION }, capabilities: { sessions: true, commands: true, eventSubscriptions: true, approvals: true } };
          break;
        case "health": result = await this.client.health(); break;
        case "sessions.list": result = { sessions: await this.client.listSessions() }; break;
        case "sessions.create": result = await this.client.createSession({
          ...(text(params.name, 200) ? { name: text(params.name, 200)! } : {}),
          ...(text(params.workspacePath, 4_000) ? { workspacePath: text(params.workspacePath, 4_000)! } : {}),
          ...(text(params.agentProfileId, 500) ? { agentProfileId: text(params.agentProfileId, 500)! } : {}),
        }); break;
        case "sessions.get": result = await this.client.getSession(requiredText(params.sessionId, 500, "sessionId")); break;
        case "sessions.prompt": result = await this.client.prompt(requiredText(params.sessionId, 500, "sessionId"), requiredText(params.text, 1_000_000, "text"), text(params.commandId, 500)); break;
        case "sessions.command": result = await this.client.command(
          requiredText(params.sessionId, 500, "sessionId"),
          requiredText(params.kind, 100, "kind"),
          params.payload ?? {},
          {
            ...(text(params.commandId, 500) ? { commandId: text(params.commandId, 500)! } : {}),
            ...(integer(params.expectedGeneration, 0, Number.MAX_SAFE_INTEGER) !== undefined ? { expectedGeneration: integer(params.expectedGeneration, 0, Number.MAX_SAFE_INTEGER)! } : {}),
          },
        ); break;
        case "sessions.cancel": result = await this.client.command(requiredText(params.sessionId, 500, "sessionId"), "session.cancel", {}); break;
        case "sessions.pause": result = await this.client.command(requiredText(params.sessionId, 500, "sessionId"), "session.pause", {}); break;
        case "sessions.resume": result = await this.client.command(requiredText(params.sessionId, 500, "sessionId"), "session.resume", {}); break;
        case "sessions.close": result = await this.client.command(requiredText(params.sessionId, 500, "sessionId"), "session.close", {}); break;
        case "sessions.compact": result = await this.client.command(requiredText(params.sessionId, 500, "sessionId"), "session.compact", {}); break;
        case "sessions.events": result = { events: await this.client.events(requiredText(params.sessionId, 500, "sessionId"), integer(params.afterSequence, 0, Number.MAX_SAFE_INTEGER) ?? 0, integer(params.limit, 1, 5000) ?? 1000) }; break;
        case "sessions.subscribe": result = this.subscribe(requiredText(params.sessionId, 500, "sessionId"), integer(params.afterSequence, 0, Number.MAX_SAFE_INTEGER) ?? 0); break;
        case "sessions.unsubscribe": result = { removed: this.unsubscribe(requiredText(params.subscriptionId, 500, "subscriptionId")) }; break;
        case "approvals.list": result = { approvals: await this.client.approvals(text(params.sessionId, 500)) }; break;
        case "approvals.resolve": result = await this.client.resolveApproval(requiredText(params.approvalId, 500, "approvalId"), resolution(params.resolution)); break;
        case "shutdown": await this.shutdown(); result = {}; break;
        default: return errorResponse(request.id ?? null, -32601, `Method not found: ${request.method}`);
      }
      return request.id === undefined ? undefined : { jsonrpc: "2.0", id: request.id ?? null, result };
    } catch (error) {
      if (request.id === undefined) return undefined;
      if (error instanceof HafApiError) return errorResponse(request.id ?? null, -32000 - Math.min(999, error.status), error.message, { status: error.status, code: error.code, retryable: error.retryable });
      return errorResponse(request.id ?? null, -32602, error instanceof Error ? error.message.slice(0, 500) : "Invalid params.");
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.subscriptions.values()) controller.abort();
    this.subscriptions.clear();
  }

  private subscribe(sessionId: string, afterSequence: number): { subscriptionId: string } {
    if (this.subscriptions.size >= 100) throw new Error("A headless client is limited to 100 event subscriptions.");
    const subscriptionId = randomUUID();
    const controller = new AbortController();
    this.subscriptions.set(subscriptionId, controller);
    void this.client.subscribe(sessionId, {
      afterSequence,
      signal: controller.signal,
      onEvent: (event) => this.emit({ jsonrpc: "2.0", method: "sessions.event", params: { subscriptionId, sessionId, event } }),
      onReconnect: (state) => this.emit({ jsonrpc: "2.0", method: "sessions.reconnecting", params: { subscriptionId, sessionId, ...state } }),
    }).catch((error) => {
      if (!controller.signal.aborted) this.emit({ jsonrpc: "2.0", method: "sessions.subscriptionError", params: { subscriptionId, sessionId, error: safeError(error) } });
    }).finally(() => this.subscriptions.delete(subscriptionId));
    return { subscriptionId };
  }

  private unsubscribe(subscriptionId: string): boolean {
    const controller = this.subscriptions.get(subscriptionId);
    if (!controller) return false;
    controller.abort();
    this.subscriptions.delete(subscriptionId);
    return true;
  }
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.jsonrpc === "2.0" && typeof item.method === "string" && item.method.length > 0 && item.method.length <= 200
    && (item.id === undefined || item.id === null || typeof item.id === "string" || typeof item.id === "number");
}
function requestId(value: unknown): string | number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as any).id;
  return id === null || typeof id === "string" || typeof id === "number" ? id : null;
}
function errorResponse(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("params must be an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error("String parameter is invalid.");
  return value;
}
function requiredText(value: unknown, max: number, name: string): string {
  const result = text(value, max)?.trim();
  if (!result) throw new Error(`${name} is required.`);
  return result;
}
function integer(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`Integer parameter must be between ${min} and ${max}.`);
  return value;
}
function resolution(value: unknown): "approve_once" | "approve_session" | "deny" {
  if (value === "approve_once" || value === "approve_session" || value === "deny") return value;
  throw new Error("resolution must be approve_once, approve_session or deny.");
}
function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof HafApiError) return { code: error.code, message: error.message };
  return { code: "subscription_failed", message: error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500) : "Subscription failed." };
}
