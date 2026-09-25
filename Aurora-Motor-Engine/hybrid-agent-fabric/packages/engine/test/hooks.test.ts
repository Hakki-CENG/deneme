import { describe, expect, it } from "vitest";
import { HookBus } from "../src/plugins/hook-bus.js";

describe("plugin hook failure semantics", () => {
  it("fails closed when a security guard crashes", async () => {
    const hooks = new HookBus();
    hooks.register({ pluginId: "security.test", hook: "pre_capability", kind: "guard", callback: () => { throw new Error("boom"); } });
    const result = await hooks.invokeGuard("pre_capability", { capability: "x" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("failed closed");
  });

  it("keeps observers off the caller hot path and isolates failures", async () => {
    const hooks = new HookBus();
    let observed = 0;
    hooks.register({ pluginId: "observer.test", hook: "event", kind: "observer", callback: async () => { observed++; throw new Error("ignored"); } });
    hooks.emitObserver("event", { value: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(observed).toBe(1);
  });

  it("preserves the last good value when a transform fails", async () => {
    const hooks = new HookBus();
    hooks.register({ pluginId: "transform.first", hook: "text", kind: "transform", callback: (value: string) => `${value}!` });
    hooks.register({ pluginId: "transform.bad", hook: "text", kind: "transform", callback: () => { throw new Error("bad"); } });
    expect(await hooks.invokeTransform("text", "hello")).toBe("hello!");
  });
});
