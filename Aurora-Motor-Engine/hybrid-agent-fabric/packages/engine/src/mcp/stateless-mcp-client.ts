import { randomUUID } from "node:crypto";
import { auroraInteger, auroraText } from "../util/aurora-state.js";
import { ENGINE_VERSION } from "../version.js";

export const MCP_STATELESS_REVISION = "2026-07-28";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_STATE_CHARS = 4096;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LIST_TTL_MS = 60_000;
const MAX_TASK_POLLS = 60;
const DEFAULT_TASK_POLL_MS = 1000;
const MAX_SUBSCRIPTION_MS = 30 * 60_000;

/**
 * Error codes the 2026-07-28 revision renumbered. They are worth naming rather than passing through as
 * anonymous integers: each one means the *client* did something the server cannot serve, and each has a
 * different correct response — stop asking, add a capability, or fix the header we sent.
 */
export const MCP_ERROR_CODES = {
  headerMismatch: -32020,
  missingRequiredClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const;

export class McpProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly kind: "header-mismatch" | "missing-capability" | "unsupported-version" | "server-error") {
    super(message);
    this.name = "McpProtocolError";
  }
}

function classify(code: number | undefined): McpProtocolError["kind"] {
  if (code === MCP_ERROR_CODES.headerMismatch) return "header-mismatch";
  if (code === MCP_ERROR_CODES.missingRequiredClientCapability) return "missing-capability";
  if (code === MCP_ERROR_CODES.unsupportedProtocolVersion) return "unsupported-version";
  return "server-error";
}

export interface StatelessMcpOptions {
  endpoint: string;
  /** Refuse plain HTTP unless a deployment explicitly opts in (loopback development). */
  allowPlainHttp?: boolean;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  /** How long `server/discover` and list results may be reused. The revision makes them cacheable. */
  listCacheTtlMs?: number;
  clientInfo?: { name: string; version: string };
  /** Per-request log level, sent in `_meta`. The revision removed `logging/setLevel`. */
  logLevel?: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";
  /** How long to keep polling a task handle before giving up. */
  taskPollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface DiscoverResult {
  protocolVersion: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  instructions?: string;
  fromCache: boolean;
  fetchedAt: string;
}

export interface InputRequest {
  id: string;
  prompt: string;
  /** `choice` carries options; anything else is free text the caller must gather. */
  kind: "choice" | "text" | "confirmation";
  options?: Array<{ id: string; label: string }>;
}

export type ToolCallOutcome =
  | { status: "completed"; result: unknown }
  | { status: "input-required"; requestState: string; requestId: string; inputRequests: InputRequest[] }
  | { status: "task"; taskId: string; state: string; pollIntervalMs?: number }
  | { status: "error"; code: number; message: string; kind?: McpProtocolError["kind"] };

export interface McpTaskStatus {
  taskId: string;
  /** Server-defined lifecycle state; `completed`, `failed` and `cancelled` are terminal. */
  state: string;
  terminal: boolean;
  result?: unknown;
  error?: { code?: number; message?: string };
  pollIntervalMs?: number;
}

export type McpChangeNotification =
  | { type: "toolsListChanged" }
  | { type: "promptsListChanged" }
  | { type: "resourcesListChanged" }
  | { type: "resourceUpdated"; uri: string }
  | { type: "other"; method: string };

/**
 * A client for the MCP 2026-07-28 stateless revision.
 *
 * The specification removed the `initialize` handshake and `Mcp-Session-Id` entirely: every request
 * now self-describes through `_meta` and routing headers, capabilities come from an optional
 * `server/discover`, list results are cacheable, and server-initiated requests (elicitation, sampling)
 * are replaced by **Multi Round-Trip Requests** — the server answers `input_required` with a
 * `requestState`, and the client re-issues the original call with the answers attached.
 *
 * The SDK-backed manager keeps speaking the handshake revision for existing servers; this client is
 * what lets Aurora talk to servers that migrated. Three properties matter more than protocol coverage:
 *
 * - **`requestState` is attacker-controlled input.** It round-trips through us from the server, so it
 *   is length-bounded, never parsed, never interpreted, and never allowed to influence authorization
 *   here — it is echoed back verbatim and nothing else.
 * - **Headers must agree with the body.** The revision requires `MCP-Protocol-Version`, `Mcp-Method`
 *   and (for named calls) `Mcp-Name`; we send them and refuse to construct a request whose header
 *   would disagree with its body, because that mismatch is exactly what gateway confusion attacks use.
 * - **Startup never blocks a turn.** `server/discover` is optional in the revision: a failure marks the
 *   server degraded and leaves tool calls to fail on their own terms, rather than hanging a session.
 */
export class StatelessMcpClient {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private discovered: { value: DiscoverResult; at: number; ttlMs?: number } | undefined;
  private toolCache: { value: McpToolDescriptor[]; at: number; ttlMs?: number } | undefined;
  /** Set once a server tells us it cannot serve this revision, so we stop asking it. */
  private unsupportedRevision: string | undefined;
  private lastServerInfo: { name?: string; version?: string } | undefined;

  constructor(private readonly options: StatelessMcpOptions) {
    const endpoint = new URL(auroraText(options.endpoint, 2000, "MCP endpoint"));
    if (endpoint.protocol !== "https:" && !options.allowPlainHttp) {
      throw new Error("Stateless MCP requires HTTPS unless plain HTTP is explicitly enabled.");
    }
    if (endpoint.username || endpoint.password) throw new Error("MCP endpoints must not embed credentials.");
    this.endpoint = endpoint;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /** Optional in the revision, so a failure is reported, not thrown into the caller's turn. */
  async discover(force = false): Promise<DiscoverResult | { failed: true; reason: string }> {
    const ttl = auroraInteger(this.options.listCacheTtlMs ?? DEFAULT_LIST_TTL_MS, 0, 3_600_000, "List cache TTL");
    if (!force && this.discovered && this.now() - this.discovered.at < (this.discovered.ttlMs ?? ttl)) {
      return { ...this.discovered.value, fromCache: true };
    }
    try {
      const result = await this.rpc<{ protocolVersion?: string; serverInfo?: DiscoverResult["serverInfo"]; capabilities?: Record<string, unknown>; instructions?: string; ttlMs?: number; cacheScope?: string }>("server/discover", {});
      const value: DiscoverResult = {
        protocolVersion: result.protocolVersion ?? MCP_STATELESS_REVISION,
        ...(result.serverInfo ? { serverInfo: result.serverInfo } : {}),
        ...(result.capabilities ? { capabilities: result.capabilities } : {}),
        ...(result.instructions ? { instructions: result.instructions.slice(0, 10_000) } : {}),
        fromCache: false,
        fetchedAt: new Date(this.now()).toISOString(),
      };
      this.discovered = { value, at: this.now(), ...this.cacheHint(result) };
      // `cacheScope: "none"` is a server saying "do not reuse this"; honouring it is the whole point
      // of the hint, and ignoring it is how a client serves a stale tool list after a deployment.
      if (this.discovered.ttlMs === 0) this.discovered = undefined;
      return value;
    } catch (error) {
      return { failed: true, reason: `${(error as Error).message}`.slice(0, 300) };
    }
  }

  /** Cacheable per the revision: list results no longer vary per connection. */
  async listTools(force = false): Promise<{ tools: McpToolDescriptor[]; fromCache: boolean }> {
    const ttl = auroraInteger(this.options.listCacheTtlMs ?? DEFAULT_LIST_TTL_MS, 0, 3_600_000, "List cache TTL");
    if (!force && this.toolCache && this.now() - this.toolCache.at < (this.toolCache.ttlMs ?? ttl)) {
      return { tools: this.toolCache.value.map((item) => structuredClone(item)), fromCache: true };
    }
    const result = await this.rpc<{ tools?: McpToolDescriptor[]; ttlMs?: number; cacheScope?: string }>("tools/list", {});
    const tools = (result.tools ?? []).slice(0, 1000).map((tool) => ({
      name: auroraText(tool.name, 200, "Tool name"),
      ...(tool.description ? { description: String(tool.description).slice(0, 4000) } : {}),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    }));
    this.toolCache = { value: tools, at: this.now(), ...this.cacheHint(result) };
    if (this.toolCache.ttlMs === 0) this.toolCache = undefined;
    return { tools: tools.map((item) => structuredClone(item)), fromCache: false };
  }

  /**
   * Call a tool. When the server needs something mid-call it answers `input_required`; gather the
   * answers and call again with `inputResponses`, the same `requestId` and the returned `requestState`.
   */
  async callTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
    requestId?: string;
    requestState?: string;
    inputResponses?: Array<{ id: string; value: string }>;
  }): Promise<ToolCallOutcome> {
    const name = auroraText(input.name, 200, "Tool name");
    const requestId = input.requestId ?? randomUUID();
    if (input.requestState !== undefined && input.requestState.length > MAX_REQUEST_STATE_CHARS) {
      throw new Error("Server requestState exceeds the accepted bound.");
    }
    const params: Record<string, unknown> = {
      name,
      arguments: input.arguments ?? {},
      ...(input.requestState ? { requestState: input.requestState } : {}),
      ...(input.inputResponses?.length ? { inputResponses: input.inputResponses.slice(0, 20) } : {}),
    };

    try {
      const result = await this.rpc<Record<string, unknown>>("tools/call", params, { id: requestId, name });
      if (result && result["resultType"] === "input_required") {
        const requestState = String(result["requestState"] ?? "");
        if (!requestState || requestState.length > MAX_REQUEST_STATE_CHARS) {
          return { status: "error", code: -32600, message: "Server asked for input without a usable requestState." };
        }
        const requests = Array.isArray(result["inputRequests"]) ? result["inputRequests"] as Array<Record<string, unknown>> : [];
        return {
          status: "input-required",
          requestState,
          requestId,
          inputRequests: requests.slice(0, 10).map((item, index) => ({
            id: String(item["id"] ?? `input-${index + 1}`).slice(0, 100),
            prompt: String(item["prompt"] ?? item["message"] ?? "Input required").slice(0, 2000),
            kind: item["kind"] === "choice" || item["kind"] === "confirmation" ? item["kind"] as "choice" | "confirmation" : "text",
            ...(Array.isArray(item["options"])
              ? {
                options: (item["options"] as Array<Record<string, unknown>>).slice(0, 6).map((option, optionIndex) => ({
                  id: String(option["id"] ?? `option-${optionIndex + 1}`).slice(0, 100),
                  label: String(option["label"] ?? option["id"] ?? `option ${optionIndex + 1}`).slice(0, 200),
                })),
              }
              : {}),
          })),
        };
      }
      const task = this.taskHandle(result);
      // A task handle means "this will take a while": the revision moved long work out of the response
      // and into polling, so the call returns a handle rather than holding a connection open.
      if (task) return { status: "task", taskId: task.taskId, state: task.state, ...(task.pollIntervalMs ? { pollIntervalMs: task.pollIntervalMs } : {}) };
      return { status: "completed", result };
    } catch (error) {
      if (error instanceof McpProtocolError) {
        return { status: "error", code: error.code, message: error.message.slice(0, 500), kind: error.kind };
      }
      return { status: "error", code: -32000, message: `${(error as Error).message}`.slice(0, 500) };
    }
  }

  /** Poll a task handle once. Terminal states are the server's, not ours, so they are reported as given. */
  async getTask(taskId: string): Promise<McpTaskStatus> {
    const result = await this.rpc<Record<string, unknown>>("tasks/get", { taskId: auroraText(taskId, 300, "Task id") });
    const state = String(result["state"] ?? result["status"] ?? "unknown").slice(0, 100);
    return {
      taskId,
      state,
      terminal: ["completed", "failed", "cancelled", "canceled", "error"].includes(state),
      ...(result["result"] === undefined ? {} : { result: result["result"] }),
      ...(result["error"] ? { error: result["error"] as { code?: number; message?: string } } : {}),
      ...(typeof result["pollIntervalMs"] === "number" ? { pollIntervalMs: result["pollIntervalMs"] } : {}),
    };
  }

  /** Send client-to-server input for a running task (`tasks/update` replaced the blocking result call). */
  async updateTask(taskId: string, input: Record<string, unknown>): Promise<McpTaskStatus> {
    await this.rpc("tasks/update", { taskId: auroraText(taskId, 300, "Task id"), input });
    return await this.getTask(taskId);
  }

  /**
   * Poll a task to a terminal state. Bounded in both directions: a maximum number of polls, and a
   * server-suggested interval that cannot drop below a floor, so a server cannot turn "please poll"
   * into a busy loop against us.
   */
  async awaitTask(taskId: string, options: { maxPolls?: number; intervalMs?: number; signal?: AbortSignal } = {}): Promise<McpTaskStatus> {
    const maxPolls = auroraInteger(options.maxPolls ?? MAX_TASK_POLLS, 1, 600, "Task polls");
    let interval = auroraInteger(options.intervalMs ?? this.options.taskPollIntervalMs ?? DEFAULT_TASK_POLL_MS, 100, 60_000, "Task poll interval");
    let status = await this.getTask(taskId);
    for (let poll = 1; poll < maxPolls && !status.terminal; poll++) {
      if (options.signal?.aborted) return { ...status, state: "cancelled", terminal: true };
      if (status.pollIntervalMs) interval = Math.min(60_000, Math.max(100, status.pollIntervalMs));
      await new Promise((tick) => {
        const timer = setTimeout(tick, interval);
        timer.unref?.();
      });
      status = await this.getTask(taskId);
    }
    return status;
  }

  /**
   * Opt into server-to-client change notifications over the single long-lived stream the revision
   * kept (`subscriptions/listen`). Returns a stop function; the stream also stops on its own after a
   * bounded lifetime, because an agent runtime should not hold a connection open forever by accident.
   */
  async listen(input: {
    types: Array<"toolsListChanged" | "promptsListChanged" | "resourcesListChanged" | "resourceSubscriptions">;
    onNotification: (notification: McpChangeNotification) => void;
    maxLifetimeMs?: number;
    resourceUris?: string[];
  }): Promise<{ stop: () => void }> {
    const controller = new AbortController();
    const lifetime = auroraInteger(input.maxLifetimeMs ?? MAX_SUBSCRIPTION_MS, 1000, MAX_SUBSCRIPTION_MS, "Subscription lifetime");
    const timer = setTimeout(() => controller.abort(), lifetime);
    timer.unref?.();

    const body = this.envelope("subscriptions/listen", {
      subscribe: input.types.slice(0, 4),
      ...(input.resourceUris?.length ? { resourceUris: input.resourceUris.slice(0, 100) } : {}),
    });
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { ...this.routingHeaders("subscriptions/listen"), accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      clearTimeout(timer);
      throw new Error(`MCP subscription failed with HTTP ${response.status}.`);
    }

    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          // A notification stream is still bounded: an endless one is a memory leak with a spec citation.
          if (bytes > MAX_RESPONSE_BYTES) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.replace(/^data:\s*/, "").trim();
            if (!trimmed) continue;
            let parsed: { method?: string; params?: Record<string, unknown> };
            try {
              parsed = JSON.parse(trimmed) as typeof parsed;
            } catch {
              continue;
            }
            const method = String(parsed.method ?? "");
            const notification = this.changeNotification(method, parsed.params ?? {});
            if (!notification) continue;
            // A list-changed notification invalidates exactly what it names; nothing else is touched.
            if (notification.type === "toolsListChanged") this.toolCache = undefined;
            try {
              input.onNotification(notification);
            } catch {
              // A broken listener must never break the stream it is reading.
            }
          }
        }
      } catch {
        // A dropped stream is normal: the caller re-subscribes if it still cares.
      } finally {
        clearTimeout(timer);
        reader.releaseLock();
      }
    })();

    return {
      stop: () => {
        clearTimeout(timer);
        controller.abort();
      },
    };
  }

  /** What the server last said it was, from `_meta` on any result. */
  serverInfo(): { name?: string; version?: string } | undefined {
    return this.lastServerInfo ? { ...this.lastServerInfo } : undefined;
  }

  private changeNotification(method: string, params: Record<string, unknown>): McpChangeNotification | undefined {
    if (method.endsWith("tools/list_changed") || method === "notifications/tools/list_changed") return { type: "toolsListChanged" };
    if (method.endsWith("prompts/list_changed")) return { type: "promptsListChanged" };
    if (method.endsWith("resources/list_changed")) return { type: "resourcesListChanged" };
    if (method.endsWith("resources/updated")) return { type: "resourceUpdated", uri: String(params["uri"] ?? "").slice(0, 2000) };
    if (!method) return undefined;
    return { type: "other", method: method.slice(0, 200) };
  }

  private cacheHint(result: { ttlMs?: number; cacheScope?: string }): { ttlMs?: number } {
    if (result.cacheScope === "none") return { ttlMs: 0 };
    if (typeof result.ttlMs === "number" && Number.isFinite(result.ttlMs)) {
      return { ttlMs: Math.min(3_600_000, Math.max(0, Math.floor(result.ttlMs))) };
    }
    return {};
  }

  private taskHandle(result: Record<string, unknown> | undefined): { taskId: string; state: string; pollIntervalMs?: number } | undefined {
    if (!result) return undefined;
    const direct = result["task"] as Record<string, unknown> | undefined;
    const taskId = String((direct?.["taskId"] ?? result["taskId"] ?? "") as string);
    if (!taskId) return undefined;
    const state = String((direct?.["state"] ?? result["state"] ?? "working") as string).slice(0, 100);
    const interval = (direct?.["pollIntervalMs"] ?? result["pollIntervalMs"]) as number | undefined;
    return { taskId: taskId.slice(0, 300), state, ...(typeof interval === "number" ? { pollIntervalMs: interval } : {}) };
  }

  /**
   * Drive a tool call to completion, delegating any mid-call input request to the caller. Bounded to a
   * few rounds so a server cannot keep a turn alive by asking forever.
   */
  async callToolInteractive(input: {
    name: string;
    arguments?: Record<string, unknown>;
    resolveInputs: (requests: InputRequest[]) => Promise<Array<{ id: string; value: string }>>;
    maxRounds?: number;
    /** Poll a returned task handle to completion instead of handing the handle back. Default on. */
    awaitTasks?: boolean;
    maxTaskPolls?: number;
  }): Promise<ToolCallOutcome & { rounds: number }> {
    const maxRounds = auroraInteger(input.maxRounds ?? 3, 1, 10, "Input rounds");
    let outcome = await this.callTool({ name: input.name, ...(input.arguments ? { arguments: input.arguments } : {}) });
    let rounds = 1;
    while (outcome.status === "input-required" && rounds < maxRounds) {
      const answers = await input.resolveInputs(outcome.inputRequests);
      outcome = await this.callTool({
        name: input.name,
        ...(input.arguments ? { arguments: input.arguments } : {}),
        requestId: outcome.requestId,
        requestState: outcome.requestState,
        inputResponses: answers,
      });
      rounds++;
    }
    if (outcome.status === "input-required") {
      return { status: "error", code: -32001, message: `Server still requires input after ${rounds} round(s).`, rounds };
    }
    // A task handle is an implementation detail of "this takes a while", not something every caller
    // should have to learn: poll it here unless the caller explicitly wants the handle.
    if (outcome.status === "task" && input.awaitTasks !== false) {
      const status = await this.awaitTask(outcome.taskId, {
        ...(input.maxTaskPolls === undefined ? {} : { maxPolls: input.maxTaskPolls }),
        ...(outcome.pollIntervalMs ? { intervalMs: outcome.pollIntervalMs } : {}),
      });
      if (!status.terminal) return { status: "error", code: -32002, message: `Task ${status.taskId} did not finish in time (state ${status.state}).`, rounds };
      if (status.state !== "completed") {
        return { status: "error", code: status.error?.code ?? -32003, message: status.error?.message ?? `Task ended in state ${status.state}.`, rounds };
      }
      return { status: "completed", result: status.result ?? null, rounds };
    }
    return { ...outcome, rounds };
  }

  /** The JSON-RPC envelope, including the `_meta` fields the revision moved off the handshake. */
  private envelope(method: string, params: Record<string, unknown>, id: string = randomUUID()): Record<string, unknown> {
    return {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_STATELESS_REVISION,
          "io.modelcontextprotocol/clientInfo": this.options.clientInfo ?? { name: "hybrid-agent-fabric", version: ENGINE_VERSION },
          "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} }, extensions: { "io.modelcontextprotocol/tasks": {} } },
          // `logging/setLevel` is gone; the level rides per request, and a server must not emit log
          // notifications for requests that did not ask for them.
          ...(this.options.logLevel ? { "io.modelcontextprotocol/logLevel": this.options.logLevel } : {}),
        },
      },
    };
  }

  /** Routing headers, self-checked against the method and name they claim to describe. */
  private routingHeaders(method: string, name?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "MCP-Protocol-Version": MCP_STATELESS_REVISION,
      "Mcp-Method": method,
      ...(this.options.headers ?? {}),
    };
    if (name) headers["Mcp-Name"] = name;
    if (headers["Mcp-Method"] !== method) throw new Error("Refusing to send an MCP request whose method header disagrees with its body.");
    if (name && headers["Mcp-Name"] !== name) throw new Error("Refusing to send an MCP request whose name header disagrees with its body.");
    // The revision removed sessions outright: we never send one, whatever a caller configured.
    delete headers["Mcp-Session-Id"];
    delete headers["mcp-session-id"];
    return headers;
  }

  private async rpc<T>(method: string, params: Record<string, unknown>, options: { id?: string; name?: string } = {}): Promise<T> {
    if (this.unsupportedRevision) {
      throw new McpProtocolError(
        MCP_ERROR_CODES.unsupportedProtocolVersion,
        `Server does not serve ${MCP_STATELESS_REVISION} (${this.unsupportedRevision}); not retrying.`,
        "unsupported-version",
      );
    }
    const id = options.id ?? randomUUID();
    const body = this.envelope(method, params, id);
    const headers = this.routingHeaders(method, options.name);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), auroraInteger(this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, 600_000, "MCP timeout"));
    timeout.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("MCP redirects are refused.");
    if (!response.ok) throw new Error(`MCP request failed with HTTP ${response.status}.`);

    const text = await boundedText(response);
    let payload: { result?: T & { _meta?: Record<string, unknown> }; error?: { code?: number; message?: string } };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      throw new Error("MCP response was not valid JSON.");
    }
    if (payload.error) {
      const code = payload.error.code ?? -32000;
      const kind = classify(code);
      // A version the server cannot serve is permanent for this endpoint: retrying it every turn just
      // spends the user's time to be told the same thing.
      if (kind === "unsupported-version") this.unsupportedRevision = String(payload.error.message ?? "unsupported").slice(0, 200);
      throw new McpProtocolError(code, `MCP error ${code}: ${String(payload.error.message ?? "unknown").slice(0, 300)}`, kind);
    }
    const meta = (payload.result as { _meta?: Record<string, unknown> } | undefined)?._meta;
    const serverInfo = meta?.["io.modelcontextprotocol/serverInfo"] as { name?: string; version?: string } | undefined;
    if (serverInfo) this.lastServerInfo = { ...(serverInfo.name ? { name: String(serverInfo.name).slice(0, 200) } : {}), ...(serverInfo.version ? { version: String(serverInfo.version).slice(0, 100) } : {}) };
    return (payload.result ?? {}) as T;
  }
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("MCP response exceeded its safety bound.");
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
