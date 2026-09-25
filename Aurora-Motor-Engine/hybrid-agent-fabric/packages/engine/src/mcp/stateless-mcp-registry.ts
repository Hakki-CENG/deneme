import type { CapabilityBroker } from "../capabilities/capability-broker.js";
import type { Capability, JsonValue } from "../types.js";
import { asJsonValue } from "../util/json.js";
import { auroraInteger, auroraText } from "../util/aurora-state.js";
import { MCP_STATELESS_REVISION, StatelessMcpClient, type InputRequest, type StatelessMcpOptions } from "./stateless-mcp-client.js";

export interface StatelessServerConfig {
  name: string;
  endpoint: string;
  allowPlainHttp?: boolean;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  listCacheTtlMs?: number;
  /** Maximum multi-round-trip rounds a single tool call may take. */
  maxInputRounds?: number;
}

export interface StatelessServerStatus {
  name: string;
  endpoint: string;
  protocolVersion: string;
  state: "ready" | "degraded";
  detail: string;
  tools: string[];
  connectedAt: string;
}

interface Registered {
  config: StatelessServerConfig;
  client: StatelessMcpClient;
  status: StatelessServerStatus;
  capabilityIds: string[];
}

/**
 * Registers 2026-07-28 MCP servers as governed capabilities.
 *
 * Two decisions carry the weight here:
 *
 * - **A failed discovery degrades, it does not block.** The revision made `server/discover` optional
 *   precisely so a slow or broken server cannot hold up a turn. A degraded server still registers the
 *   tools it managed to list, and says so in its status.
 * - **Mid-call input requests become real questions to the human.** The revision replaced elicitation
 *   with Multi Round-Trip Requests; rather than auto-answering them — which would hand a remote server
 *   the ability to script its own confirmations — each request is put to the user through the same
 *   bounded question service the agent uses, and a timeout ends the call rather than guessing.
 */
export class StatelessMcpRegistry {
  private readonly servers = new Map<string, Registered>();

  constructor(
    private readonly broker: CapabilityBroker,
    private readonly deps: {
      /** Optional: how a mid-call input request reaches a human. Absent means such calls fail. */
      askUser?: (input: { tenantId: string; sessionId: string; requests: InputRequest[] }) => Promise<Array<{ id: string; value: string }>>;
      clientFactory?: (options: StatelessMcpOptions) => StatelessMcpClient;
    } = {},
  ) {}

  async connect(config: StatelessServerConfig): Promise<StatelessServerStatus> {
    const name = auroraText(config.name, 100, "Server name").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(name)) throw new Error("MCP server name must be lowercase letters, digits and dashes.");
    if (this.servers.has(name)) throw new Error(`MCP server "${name}" is already connected.`);

    const options: StatelessMcpOptions = {
      endpoint: config.endpoint,
      ...(config.allowPlainHttp !== undefined ? { allowPlainHttp: config.allowPlainHttp } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
      ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
      ...(config.listCacheTtlMs !== undefined ? { listCacheTtlMs: config.listCacheTtlMs } : {}),
    };
    const client = this.deps.clientFactory ? this.deps.clientFactory(options) : new StatelessMcpClient(options);

    const discovered = await client.discover();
    const degradedReason = "failed" in discovered ? discovered.reason : undefined;

    let tools: Awaited<ReturnType<StatelessMcpClient["listTools"]>>["tools"] = [];
    let listError: string | undefined;
    try {
      tools = (await client.listTools()).tools;
    } catch (error) {
      listError = `${(error as Error).message}`.slice(0, 300);
    }

    const capabilities: Capability[] = tools.map((tool) => this.capabilityFor(name, tool.name, tool.description, tool.inputSchema, client, config));
    const capabilityIds = capabilities.map((item) => item.descriptor.id);
    if (new Set(capabilityIds).size !== capabilityIds.length) throw new Error(`MCP server "${name}" exposed colliding tool names.`);
    for (const capability of capabilities) this.broker.register(capability);

    const status: StatelessServerStatus = {
      name,
      endpoint: config.endpoint,
      protocolVersion: "failed" in discovered ? MCP_STATELESS_REVISION : discovered.protocolVersion,
      state: degradedReason || listError ? "degraded" : "ready",
      detail: degradedReason
        ? `Discovery failed: ${degradedReason}${listError ? `; tool listing failed: ${listError}` : ""}`
        : listError
          ? `Tool listing failed: ${listError}`
          : `Discovered ${tools.length} tool(s).`,
      tools: tools.map((item) => item.name),
      connectedAt: new Date().toISOString(),
    };
    this.servers.set(name, { config, client, status, capabilityIds });
    return structuredClone(status);
  }

  async disconnect(name: string): Promise<{ name: string; disconnected: boolean }> {
    const server = this.servers.get(name);
    if (!server) return { name, disconnected: false };
    for (const id of server.capabilityIds) this.broker.unregister(id);
    this.servers.delete(name);
    return { name, disconnected: true };
  }

  /** Re-list tools and re-register. The revision's cacheable listings make this cheap. */
  async refresh(name: string): Promise<StatelessServerStatus> {
    const server = this.servers.get(name);
    if (!server) throw new Error(`MCP server "${name}" is not connected.`);
    await this.disconnect(name);
    return await this.connect(server.config);
  }

  list(): StatelessServerStatus[] {
    return [...this.servers.values()].map((item) => structuredClone(item.status));
  }

  private capabilityFor(
    serverName: string,
    toolName: string,
    description: string | undefined,
    inputSchema: unknown,
    client: StatelessMcpClient,
    config: StatelessServerConfig,
  ): Capability {
    const id = `mcp.${serverName}.${toolName.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 100)}`;
    const rounds = auroraInteger(config.maxInputRounds ?? 3, 1, 10, "Input rounds");
    return {
      descriptor: {
        id,
        version: "1.0.0",
        description: `${description ?? `MCP tool ${toolName}`} (stateless MCP ${MCP_STATELESS_REVISION} server "${serverName}")`.slice(0, 1000),
        // Remote tools are external effects until proven otherwise; the policy stack decides the rest.
        risk: "external_side_effect",
        sideEffect: true,
        inputSchema: asJsonValue(inputSchema ?? { type: "object" }),
        source: "mcp",
      },
      validate(input: unknown): Record<string, JsonValue> {
        if (input === undefined || input === null) return {};
        if (typeof input !== "object" || Array.isArray(input)) throw new Error("MCP tool arguments must be an object.");
        return input as Record<string, JsonValue>;
      },
      execute: async (input, context) => {
        const outcome = await client.callToolInteractive({
          name: toolName,
          arguments: input as Record<string, unknown>,
          maxRounds: rounds,
          resolveInputs: async (requests) => {
            if (!this.deps.askUser) {
              throw new Error(`MCP server "${serverName}" asked for input mid-call, but no interactive channel is configured.`);
            }
            return await this.deps.askUser({ tenantId: context.tenantId, sessionId: context.sessionId, requests });
          },
        });
        if (outcome.status === "error") throw new Error(outcome.message);
        if (outcome.status === "input-required") throw new Error("MCP server still requires input.");
        if (outcome.status === "task") throw new Error(`MCP task ${outcome.taskId} is still ${outcome.state}.`);
        return asJsonValue({ result: outcome.result, rounds: outcome.rounds });
      },
    };
  }
}
