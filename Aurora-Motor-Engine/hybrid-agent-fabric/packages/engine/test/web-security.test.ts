import { afterEach, describe, expect, it, vi } from "vitest";
import { webCapabilities } from "../src/capabilities/web.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const context = {
  tenantId: "tenant",
  sessionId: "session",
  familyId: "family",
  turnId: "turn",
  toolCallId: "tool",
  source: "api" as const,
  workspacePath: "/tmp",
  idempotencyKey: "id",
};

describe("web SSRF boundary", () => {
  it("blocks loopback, private and credential-bearing URLs before fetch", async () => {
    const capability = webCapabilities()[0]!;
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(capability.execute({ url: "http://127.0.0.1/admin", format: "text" }, context)).rejects.toThrow("Private or special-use");
    await expect(capability.execute({ url: "http://10.0.0.1/", format: "text" }, context)).rejects.toThrow("Private or special-use");
    await expect(capability.execute({ url: "https://user:pass@example.com/", format: "text" }, context)).rejects.toThrow("credentials");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("bounds and sanitizes public HTML responses", async () => {
    const capability = webCapabilities()[0]!;
    globalThis.fetch = vi.fn(async () => new Response(
      '<html><style>.x{}</style><script>steal()</script><body><h1>Hello</h1> world &amp; friends</body></html>',
      { status: 200, headers: { "content-type": "text/html" } },
    )) as typeof fetch;
    const result = await capability.execute({ url: "https://93.184.216.34/", format: "text", maxBytes: 10000 }, context) as any;
    expect(result.content).toBe("Hello world & friends");
    expect(result.content).not.toContain("steal");
  });

  it("revalidates redirect destinations", async () => {
    const capability = webCapabilities()[0]!;
    globalThis.fetch = vi.fn(async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1/secret" } })) as typeof fetch;
    await expect(capability.execute({ url: "https://93.184.216.34/", format: "text" }, context)).rejects.toThrow("Private or special-use");
  });
});
