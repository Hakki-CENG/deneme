import { describe, expect, it } from "vitest";
import { HafApiClient, HafApiError } from "../src/client.js";

function json(value: unknown, status = 200): Response { return Response.json(value, { status }); }
function stream(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("HAF REST/SSE client", () => {
  it("uses environment-style bearer auth, fixed origin and bounded JSON contracts", async () => {
    const seen: Array<{ url: string; authorization: string; tenant: string; body: string }> = [];
    const client = new HafApiClient({
      baseUrl: "https://haf.example.test",
      token: "server-token-secret",
      tenantId: "tenant",
      fetch: async (input, init) => {
        const url = String(input), headers = new Headers(init?.headers);
        seen.push({ url, authorization: headers.get("authorization") ?? "", tenant: headers.get("x-haf-tenant") ?? "", body: String(init?.body ?? "") });
        if (url.endsWith("/health")) return json({ status: "ok" });
        if (url.endsWith("/v1/sessions")) return json({ sessionId: "session" }, 201);
        if (url.includes("/commands")) return json({ status: "completed" });
        return json({ error: "not_found" }, 404);
      },
    });
    expect(await client.health()).toEqual({ status: "ok" });
    expect(await client.createSession({ name: "test" })).toMatchObject({ sessionId: "session" });
    expect(await client.prompt("session", "hello", "stable-command")).toMatchObject({ status: "completed" });
    expect(seen.every((item) => item.url.startsWith("https://haf.example.test/"))).toBe(true);
    expect(seen.every((item) => item.authorization === "Bearer server-token-secret" && item.tenant === "tenant")).toBe(true);
    expect(seen.every((item) => !item.body.includes("server-token-secret"))).toBe(true);
    expect(seen.at(-1)?.body).toContain("stable-command");
  });

  it("reconnects SSE from the last sequence and suppresses replay duplicates", async () => {
    const urls: string[] = [];
    let calls = 0;
    const client = new HafApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: async (input) => {
        urls.push(String(input)); calls++;
        return calls === 1
          ? stream([{ sequence: 1, type: "one" }, { sequence: 2, type: "two" }])
          : stream([{ sequence: 2, type: "duplicate" }, { sequence: 3, type: "three" }]);
      },
    });
    const controller = new AbortController();
    const sequences: number[] = [];
    await client.subscribe("session", {
      signal: controller.signal,
      maxReconnectDelayMs: 250,
      onEvent(event) { sequences.push(event.sequence); if (event.sequence === 3) controller.abort(); },
    });
    expect(sequences).toEqual([1, 2, 3]);
    expect(urls[1]).toContain("afterSequence=2");
  });

  it("rejects redirects and does not reflect bearer credentials in errors", async () => {
    const redirect = new HafApiClient({ baseUrl: "https://haf.example.test", token: "secret", fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) });
    await expect(redirect.health()).rejects.toMatchObject({ code: "redirect_forbidden" });
    const failure = new HafApiClient({ baseUrl: "https://haf.example.test", token: "secret", fetch: async () => json({ error: "denied", message: "Bearer stolen-value" }, 403) });
    await expect(failure.health()).rejects.toSatisfy((error: unknown) => error instanceof HafApiError && !error.message.includes("stolen-value"));
  });
});

describe("Aurora CLI surface", () => {
  it("resolves allowlisted views with the tenant attached and rejects unknown ones", async () => {
    const urls: string[] = [];
    const client = new HafApiClient({
      baseUrl: "http://127.0.0.1:8787",
      tenantId: "acme",
      fetch: async (input) => { urls.push(String(input)); return Response.json({ ok: true }); },
    });
    expect(await client.auroraView("status")).toEqual({ ok: true });
    await client.auroraView("fleet-sweeps", { limit: 5 });
    await client.auroraView("enforcement", { limit: 5000 });
    expect(urls[0]).toBe("http://127.0.0.1:8787/v1/acos/status?tenantId=acme");
    expect(urls[1]).toBe("http://127.0.0.1:8787/v1/aurora/fleet/sweeps?tenantId=acme&limit=5");
    // The limit is clamped client-side, so a bad flag cannot ask the server for an unbounded page.
    expect(urls[2]).toBe("http://127.0.0.1:8787/v1/aurora/enforcement?tenantId=acme&limit=1000");
    await expect(client.auroraView("secrets" as never)).rejects.toThrow(/Unknown Aurora view/);
  });

  it("only exposes the three bounded Aurora actions", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const client = new HafApiClient({
      baseUrl: "http://127.0.0.1:8787",
      tenantId: "acme",
      fetch: async (input, init) => { seen.push({ url: String(input), body: String(init?.body ?? "") }); return Response.json({ ok: true }); },
    });
    await client.auroraAction("cycle", { mode: "reflection" });
    await client.auroraAction("fleet-sweep");
    expect(seen[0]?.url).toBe("http://127.0.0.1:8787/v1/acos/cycles");
    expect(seen[0]?.body).toContain("reflection");
    expect(seen[1]?.url).toBe("http://127.0.0.1:8787/v1/aurora/fleet/sweep");
    expect(seen[1]?.body).toContain("acme");
    await expect(client.auroraAction("purge" as never)).rejects.toThrow(/Unknown Aurora action/);
  });
});

describe("Aurora harvest surface", () => {
  it("exposes harvesting as a bounded action and its queue as a read-only view", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const client = new HafApiClient({
      baseUrl: "http://127.0.0.1:8787",
      tenantId: "acme",
      fetch: async (input, init) => { seen.push({ url: String(input), method: init?.method ?? "GET" }); return Response.json({ ok: true }); },
    });
    await client.auroraView("harvest-review", { limit: 10 });
    await client.auroraAction("harvest");
    expect(seen[0]).toEqual({ url: "http://127.0.0.1:8787/v1/harvest-review?tenantId=acme&limit=10", method: "GET" });
    expect(seen[1]).toEqual({ url: "http://127.0.0.1:8787/v1/delegations/harvest", method: "POST" });
  });
});
