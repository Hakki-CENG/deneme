import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApprovalService } from "../src/policy/approval-service.js";
import { DefaultPolicyEngine } from "../src/policy/policy-engine.js";
import { EffectJournal } from "../src/persistence/effect-journal.js";
import { CapabilityBroker } from "../src/capabilities/capability-broker.js";
import { McpManager } from "../src/mcp/mcp-manager.js";

describe("MCP capability bridge", () => {
  it("discovers a stdio tool and exposes it as a governed capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-mcp-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const broker = new CapabilityBroker(new DefaultPolicyEngine(), new ApprovalService(), new EffectJournal(root));
    const mcp = new McpManager(broker);
    const connected = await mcp.connectStdio({
      name: "echo-server",
      command: process.execPath,
      args: [resolve(process.cwd(), "test/fixtures/mcp-echo.mjs")],
      defaultRisk: "pure",
    });
    expect(connected.capabilityIds).toEqual(["mcp.echo-server.echo"]);
    const result = await broker.execute(
      "mcp.echo-server.echo",
      { text: "hello MCP" },
      {
        tenantId: "local",
        sessionId: randomUUID(),
        familyId: randomUUID(),
        turnId: randomUUID(),
        toolCallId: randomUUID(),
        source: "api",
        workspacePath: workspace,
        idempotencyKey: randomUUID(),
      },
    ) as any;
    expect(JSON.stringify(result)).toContain("hello MCP");
    await mcp.closeAll();
    expect(broker.list().some((item) => item.id === "mcp.echo-server.echo")).toBe(false);
  });
});
