import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpElicitationService } from "../src/mcp/mcp-elicitation-service.js";

async function waitPending(service: McpElicitationService) {
  for (let index = 0; index < 50; index++) {
    const values = await service.list("tenant", "pending");
    if (values.length) return values[0]!;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("elicitation did not become pending");
}

describe("human-gated MCP elicitation", () => {
  it("validates form schemas/content and never persists submitted values", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-mcp-elicit-"));
    const service = new McpElicitationService(root, 5000);
    const response = service.request("form-server", "tenant", {
      mode: "form",
      message: "Provide deployment options",
      requestedSchema: {
        type: "object",
        properties: {
          environment: { type: "string", enum: ["staging", "production"], description: "Target" },
          replicas: { type: "integer", minimum: 1, maximum: 10 },
          note: { type: "string", format: "password", maxLength: 100 },
        },
        required: ["environment", "replicas"],
      },
    });
    const pending = await waitPending(service);
    await expect(service.resolve("tenant", pending.id, {
      action: "accept", content: { environment: "invalid", replicas: 2 },
    })).rejects.toThrow("outside its enum");
    await service.resolve("tenant", pending.id, {
      action: "accept", content: { environment: "staging", replicas: 2, note: "do-not-persist" },
    });
    expect(await response).toEqual({ action: "accept", content: { environment: "staging", replicas: 2, note: "do-not-persist" } });
    const stored = await readFile(join(root, "mcp", "elicitations.json"), "utf8");
    expect(stored).not.toContain("do-not-persist");
    expect((await service.list("tenant", "accepted"))[0]).toEqual(expect.objectContaining({ status: "accepted", resolutionReason: "human_accept" }));
  });

  it("rejects unsafe URL elicitations and expires orphaned requests after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-mcp-elicit-restart-"));
    const service = new McpElicitationService(root, 5000);
    await expect(service.request("url-server", "tenant", {
      mode: "url", message: "Open internal admin", url: "http://127.0.0.1/admin",
    })).rejects.toThrow("Private or special-use");
    const response = service.request("form-server", "tenant", {
      mode: "form", message: "Pending", requestedSchema: { type: "object", properties: {}, required: [] },
    });
    await waitPending(service);
    await service.close();
    expect(await response).toEqual({ action: "cancel" });
    const reloaded = new McpElicitationService(root);
    expect((await reloaded.list("tenant", "expired"))[0]).toEqual(expect.objectContaining({ resolutionReason: "control_process_restarted" }));
  });
});
