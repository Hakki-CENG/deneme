import { randomUUID } from "node:crypto";

export interface HafApiClientOptions {
  baseUrl: string;
  token?: string;
  tenantId?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface SessionEvent {
  sequence: number;
  type: string;
  [key: string]: unknown;
}

export interface EventSubscriptionOptions {
  afterSequence?: number;
  signal: AbortSignal;
  onEvent: (event: SessionEvent) => void | Promise<void>;
  onReconnect?: (input: { attempt: number; afterSequence: number; delayMs: number }) => void;
  maxReconnectDelayMs?: number;
}

export class HafApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "HafApiError";
  }
}

export const AURORA_VIEWS = {
  status: "/v1/acos/status",
  journal: "/v1/acos/journal",
  metrics: "/v1/aurora/metrics",
  alerts: "/v1/aurora/alerts",
  selfcheck: "/v1/aurora/selfcheck",
  footprint: "/v1/aurora/footprint",
  enforcement: "/v1/aurora/enforcement",
  "enforcement-summary": "/v1/aurora/enforcement-summary",
  autopilot: "/v1/autopilot",
  "autopilot-runs": "/v1/autopilot/runs",
  delegations: "/v1/delegations",
  "role-authority": "/v1/society/authority/audit",
  "harvest-review": "/v1/harvest-review",
  "harvest-assessments": "/v1/harvest-assessments",
  "decision-feedback": "/v1/decision-feedback",
  "decision-feedback-summary": "/v1/decision-feedback/summary",
  "estimation-profile": "/v1/estimation/profile",
  probation: "/v1/society/probation",
  hooks: "/v1/hooks",
  "hook-firings": "/v1/hooks/firings",
  "session-modes": "/v1/session-modes",
  "mode-defaults": "/v1/session-modes/defaults",
  usage: "/v1/usage",
  "session-archives": "/v1/session-archives",
  "model-prices": "/v1/model-prices",
  "effort-levels": "/v1/effort-levels",
  "trust-publishers": "/v1/trust/publishers",
  "trust-pins": "/v1/trust/pins",
  "trust-decisions": "/v1/trust/decisions",
  settings: "/v1/settings/effective",
  questions: "/v1/questions",
  "auto-approvals": "/v1/auto-approvals",
  "session-budgets": "/v1/session-budgets",
  "agent-directory": "/v1/agent-directory",
  "auto-approval-decisions": "/v1/auto-approvals/decisions",
  "mcp-stateless": "/v1/mcp/stateless",
  "delegation-policy": "/v1/delegation-policy",
  fleet: "/v1/aurora/fleet",
  "fleet-members": "/v1/aurora/fleet/members",
  "fleet-sweeps": "/v1/aurora/fleet/sweeps",
  compliance: "/v1/constitution/compliance",
  initiatives: "/v1/initiative/initiatives",
  checkpoints: "/v1/checkpoints",
} as const satisfies Record<string, string>;

export type AuroraView = keyof typeof AURORA_VIEWS;
export type AuroraAction = "cycle" | "autopilot-run-due" | "fleet-sweep" | "delegation-sync" | "harvest" | "decision-feedback-reconcile";

export class HafApiClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tenantId: string;
  private readonly timeoutMs: number;
  private readonly token: string | undefined;

  constructor(options: HafApiClientOptions) {
    const base = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || !["", "/"].includes(base.pathname)) {
      throw new Error("HAF_URL must be a credential-free HTTP(S) origin.");
    }
    this.origin = base.origin;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.tenantId = options.tenantId?.trim() || "local";
    this.timeoutMs = boundedInteger(options.requestTimeoutMs ?? 30_000, 1_000, 10 * 60_000);
    this.token = options.token?.trim() || undefined;
  }

  async health(): Promise<unknown> { return await this.request("/health", { method: "GET" }); }
  async listSessions(): Promise<any[]> {
    const value = await this.request(`/v1/sessions?tenantId=${encodeURIComponent(this.tenantId)}`, { method: "GET" }) as any;
    return Array.isArray(value?.sessions) ? value.sessions : [];
  }
  async createSession(input: { name?: string; workspacePath?: string; agentProfileId?: string } = {}): Promise<any> {
    return await this.request("/v1/sessions", { method: "POST", body: { tenantId: this.tenantId, ...input } });
  }
  async getSession(sessionId: string): Promise<any> {
    return await this.request(`/v1/sessions/${segment(sessionId)}`, { method: "GET" });
  }
  async command(sessionId: string, kind: string, payload: unknown = {}, options: { commandId?: string; expectedGeneration?: number } = {}): Promise<any> {
    return await this.request(`/v1/sessions/${segment(sessionId)}/commands`, {
      method: "POST",
      timeoutMs: 10 * 60_000,
      body: {
        commandId: options.commandId ?? randomUUID(),
        clientId: "haf-headless-client",
        tenantId: this.tenantId,
        ...(options.expectedGeneration !== undefined ? { expectedGeneration: options.expectedGeneration } : {}),
        kind,
        source: "cli",
        payload,
      },
    });
  }
  async prompt(sessionId: string, text: string, commandId?: string): Promise<any> {
    if (!text.trim() || text.length > 1_000_000) throw new Error("Prompt must contain 1 to 1,000,000 characters.");
    return await this.command(sessionId, "session.prompt", { text }, { ...(commandId ? { commandId } : {}) });
  }
  async events(sessionId: string, afterSequence = 0, limit = 1000): Promise<SessionEvent[]> {
    const value = await this.request(`/v1/sessions/${segment(sessionId)}/events?afterSequence=${Math.max(0, Math.floor(afterSequence))}&limit=${Math.min(5000, Math.max(1, Math.floor(limit)))}`, { method: "GET" }) as any;
    return Array.isArray(value?.events) ? value.events : [];
  }
  async approvals(sessionId?: string): Promise<any[]> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const value = await this.request(`/v1/approvals${query}`, { method: "GET" }) as any;
    return Array.isArray(value?.approvals) ? value.approvals : [];
  }
  async resolveApproval(approvalId: string, resolution: "approve_once" | "approve_session" | "deny"): Promise<any> {
    return await this.request(`/v1/approvals/${segment(approvalId)}/resolve`, { method: "POST", body: { resolution } });
  }

  /**
   * Read-only Aurora views, exposed to the CLI through a fixed allowlist so a typo can never turn
   * into an arbitrary Control API call and no mutating endpoint is reachable by accident.
   */
  async auroraView(view: AuroraView, options: { limit?: number } = {}): Promise<unknown> {
    const path = AURORA_VIEWS[view];
    if (!path) throw new Error(`Unknown Aurora view "${view}". Known views: ${Object.keys(AURORA_VIEWS).join(", ")}.`);
    const url = new URL(path, "http://placeholder.invalid");
    url.searchParams.set("tenantId", this.tenantId);
    if (options.limit !== undefined) url.searchParams.set("limit", String(Math.min(1000, Math.max(1, Math.floor(options.limit)))));
    return await this.request(`${url.pathname}${url.search}`, { method: "GET" });
  }

  /** The three explicitly bounded Aurora actions the CLI may trigger. Everything else stays in the API. */
  async auroraAction(action: AuroraAction, options: { mode?: string } = {}): Promise<unknown> {
    if (action === "cycle") {
      return await this.request("/v1/acos/cycles", { method: "POST", timeoutMs: 10 * 60_000, body: { tenantId: this.tenantId, mode: options.mode ?? "maintenance" } });
    }
    if (action === "autopilot-run-due") {
      return await this.request("/v1/autopilot/run-due", { method: "POST", timeoutMs: 10 * 60_000, body: { tenantId: this.tenantId } });
    }
    if (action === "fleet-sweep") {
      return await this.request("/v1/aurora/fleet/sweep", { method: "POST", timeoutMs: 10 * 60_000, body: { tenantId: this.tenantId } });
    }
    if (action === "delegation-sync") {
      return await this.request("/v1/delegations/sync", { method: "POST", timeoutMs: 10 * 60_000, body: { tenantId: this.tenantId } });
    }
    if (action === "harvest") {
      return await this.request("/v1/delegations/harvest", { method: "POST", timeoutMs: 10 * 60_000, body: { tenantId: this.tenantId } });
    }
    if (action === "decision-feedback-reconcile") {
      return await this.request("/v1/decision-feedback/reconcile", { method: "POST", timeoutMs: 10 * 60_000, body: { tenantId: this.tenantId } });
    }
    throw new Error(`Unknown Aurora action "${action}". Known actions: cycle, autopilot-run-due, fleet-sweep, delegation-sync, harvest, decision-feedback-reconcile.`);
  }

  async subscribe(sessionId: string, options: EventSubscriptionOptions): Promise<void> {
    let cursor = Math.max(0, Math.floor(options.afterSequence ?? 0));
    let attempt = 0;
    const maxDelay = Math.min(30_000, Math.max(250, options.maxReconnectDelayMs ?? 10_000));
    while (!options.signal.aborted) {
      try {
        const { response, cleanup } = await this.raw(`/v1/sessions/${segment(sessionId)}/events/stream?afterSequence=${cursor}`, {
          method: "GET",
          signal: options.signal,
          timeoutMs: 0,
          accept: "text/event-stream",
        });
        try {
          if (!response.ok) throw await apiError(response);
          if (!response.body) throw new HafApiError(502, "empty_stream", "HAF event stream returned no body.", true);
          attempt = 0;
          for await (const event of parseSse(response.body, options.signal)) {
            if (typeof event.sequence !== "number" || !Number.isFinite(event.sequence) || event.sequence <= cursor) continue;
            cursor = event.sequence;
            await options.onEvent(event as SessionEvent);
          }
        } finally { cleanup(); }
        if (options.signal.aborted) return;
      } catch (error) {
        if (options.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        if (error instanceof HafApiError && !error.retryable) throw error;
      }
      attempt++;
      const delayMs = Math.min(maxDelay, 250 * 2 ** Math.min(attempt - 1, 8));
      options.onReconnect?.({ attempt, afterSequence: cursor, delayMs });
      await abortableDelay(delayMs, options.signal);
    }
  }

  private async request(path: string, input: { method: string; body?: unknown; timeoutMs?: number }): Promise<unknown> {
    const { response, cleanup } = await this.raw(path, input);
    try {
      if (!response.ok) throw await apiError(response);
      if (response.status === 204) return null;
      return await boundedJson(response, 16 * 1024 * 1024);
    } finally { cleanup(); }
  }

  private async raw(path: string, input: { method: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal; accept?: string }): Promise<{ response: Response; cleanup: () => void }> {
    if (!path.startsWith("/")) throw new Error("HAF API path must be absolute.");
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error("HAF API request origin mismatch.");
    const timeoutMs = input.timeoutMs === undefined ? this.timeoutMs : input.timeoutMs;
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    timer?.unref();
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    };
    try {
      const response = await this.fetchImpl(url, {
        method: input.method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: input.accept ?? "application/json",
          "x-haf-tenant": this.tenantId,
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        cleanup();
        throw new HafApiError(response.status, "redirect_forbidden", "HAF API redirects are forbidden.", false);
      }
      return { response, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}

async function apiError(response: Response): Promise<HafApiError> {
  let code = `http_${response.status}`;
  let detail = "";
  try {
    const value = await boundedJson(response, 64 * 1024) as any;
    if (typeof value?.error === "string") code = value.error.slice(0, 100);
    if (typeof value?.message === "string") detail = value.message;
  } catch {}
  const retryable = response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500;
  const safe = detail.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/[\r\n\t]+/g, " ").slice(0, 300);
  return new HafApiError(response.status, code, `HAF API returned HTTP ${response.status}${safe ? `: ${safe}` : "."}`, retryable);
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const text = await boundedText(response.body, maxBytes);
  try { return JSON.parse(text); }
  catch { throw new HafApiError(response.status, "invalid_json", "HAF API returned invalid JSON.", false); }
}

async function boundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HafApiError(502, "response_oversized", "HAF API response exceeded its safety bound.", false);
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally { reader.releaseLock(); }
}

async function* parseSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw new HafApiError(502, "event_oversized", "HAF event exceeded 4 MiB.", false);
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) yield parsed;
      }
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw new HafApiError(502, "event_buffer_oversized", "HAF event buffer exceeded 4 MiB.", false);
    }
  } finally { reader.releaseLock(); }
}

function segment(value: string): string {
  if (!value || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("HAF resource identifier is invalid.");
  return encodeURIComponent(value);
}
function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Expected integer ${min}-${max}.`);
  return value;
}
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
