import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserManager } from "../src/browser/browser-manager.js";
import { HybridAgentEngine } from "../src/engine.js";

describe("browser automation configuration boundary", () => {
  it("does not advertise browser capabilities when no browser backend exists", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-browser-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    expect(engine.browser.configured).toBe(false);
    expect(engine.capabilities.list().some((item) => item.id.startsWith("browser."))).toBe(false);
    await engine.shutdown();
  });

  it("advertises the full browser toolset for an explicitly configured executable", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-browser-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      browser: { executablePath: "/configured/chromium" },
      model: { provider: "mock" },
    });
    expect(engine.capabilities.list().filter((item) => item.id.startsWith("browser.") || item.id.startsWith("computer.")).map((item) => item.id)).toEqual([
      "browser.navigate", "browser.snapshot", "browser.click", "browser.type", "browser.select", "browser.upload", "browser.press",
      "computer.click", "computer.type", "computer.scroll", "browser.screenshot",
    ]);
    await engine.shutdown();
  });

  it("rejects a private CDP endpoint unless the operator explicitly opts in", async () => {
    const manager = new BrowserManager({ cdpEndpoint: "http://127.0.0.1:9222" });
    await expect(manager.navigate("session", "https://93.184.216.34/")).rejects.toThrow("Private or special-use");
  });
});
