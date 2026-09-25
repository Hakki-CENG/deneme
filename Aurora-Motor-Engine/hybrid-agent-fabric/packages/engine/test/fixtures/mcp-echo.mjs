#!/usr/bin/env node
/**
 * Minimal MCP stdio server — test fixture.
 *
 * Implements just enough of the Model Context Protocol (JSON-RPC 2.0 over
 * newline-delimited stdio) to be discovered by `McpManager.connectStdio` and
 * expose a single `echo` tool.
 */

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

const replyError = (id, code, message) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

const TOOLS = [
  {
    name: "echo",
    description: "Echoes the supplied text back to the caller.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo" },
      },
      required: ["text"],
    },
  },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = message;

  // Notifications carry no id and expect no response.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-echo-fixture", version: "1.0.0" },
      });
      return;

    case "ping":
      reply(id, {});
      return;

    case "tools/list":
      reply(id, { tools: TOOLS });
      return;

    case "tools/call": {
      const name = params?.name;
      if (name !== "echo") {
        replyError(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const text = params?.arguments?.text ?? "";
      reply(id, {
        content: [{ type: "text", text: String(text) }],
        isError: false,
      });
      return;
    }

    case "resources/list":
      reply(id, { resources: [] });
      return;

    case "prompts/list":
      reply(id, { prompts: [] });
      return;

    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
});

rl.on("close", () => process.exit(0));
