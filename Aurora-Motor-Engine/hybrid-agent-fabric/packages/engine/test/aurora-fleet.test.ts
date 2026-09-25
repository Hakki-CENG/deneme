import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuroraAutopilot, AutopilotRun } from "../src/aurora/autopilot.js";
import { AuroraFleetSupervisor } from "../src/aurora/fleet-supervisor.js";

function run(tenantId: string, status: AutopilotRun["status"] = "completed"): AutopilotRun {
  return { id: `run-${tenantId}-${status}-${Math.random()}`, tenantId, kind: "pulse", status, detail: "stub", startedAt: new Date().toISOString(), durationMs: 1 };
}

class StubAutopilot {
  readonly calls: string[] = [];
  constructor(private readonly behaviour: (tenantId: string, call: number) => AutopilotRun[]) {}
  async runDue(tenantId: string): Promise<AutopilotRun[]> {
    this.calls.push(tenantId);
    return this.behaviour(tenantId, this.calls.filter((item) => item === tenantId).length);
  }
  async health(tenantId: string): Promise<any> {
    return { tenantId, enabled: true, runsToday: 0, maxRunsPerDay: 96, failureRate: 0, cadences: [], generatedAt: new Date().toISOString() };
  }
}

async function fixture(behaviour: (tenantId: string, call: number) => AutopilotRun[], options: { maxTenantsPerSweep?: number; maxSweepsPerDay?: number } = {}, now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), "haf-aurora-fleet-"));
  const autopilot = new StubAutopilot(behaviour);
  const fleet = new AuroraFleetSupervisor(join(root, "data"), { autopilot: autopilot as unknown as AuroraAutopilot }, options, now);
  return { fleet, autopilot };
}

describe("Aurora fleet supervisor", () => {
  it("only drives tenants that were explicitly enrolled", async () => {
    const { fleet, autopilot } = await fixture(() => [run("a")]);
    await fleet.enroll({ tenantId: "alpha" });
    const sweep = await fleet.sweep();
    expect(autopilot.calls).toEqual(["alpha"]);
    expect(sweep.sweptTenants).toBe(1);
    expect(sweep.totalRuns).toBe(1);
    expect((await fleet.member("beta"))).toBeUndefined();
  });

  it("re-enrolling is idempotent and update tunes an existing member", async () => {
    const { fleet } = await fixture(() => []);
    await fleet.enroll({ tenantId: "alpha", priority: 5, note: "primary" });
    await fleet.enroll({ tenantId: "alpha" });
    expect((await fleet.members()).length).toBe(1);
    const updated = await fleet.update({ tenantId: "alpha", priority: 2, maxRunsPerSweep: 9, enabled: false });
    expect(updated.priority).toBe(2);
    expect(updated.maxRunsPerSweep).toBe(9);
    expect(updated.enabled).toBe(false);
    expect(updated.note).toBe("primary");
    await expect(fleet.update({ tenantId: "ghost" })).rejects.toThrow(/not enrolled/);
  });

  it("skips disabled tenants and stops driving withdrawn ones", async () => {
    const { fleet, autopilot } = await fixture(() => [run("x")]);
    await fleet.enroll({ tenantId: "alpha" });
    await fleet.enroll({ tenantId: "beta", enabled: false });
    await fleet.sweep();
    expect(autopilot.calls).toEqual(["alpha"]);
    expect(await fleet.withdraw("alpha")).toEqual({ tenantId: "alpha", withdrawn: true });
    expect(await fleet.withdraw("alpha")).toEqual({ tenantId: "alpha", withdrawn: false });
    await fleet.sweep();
    expect(autopilot.calls).toEqual(["alpha"]);
  });

  it("orders by priority band and then round-robins the least recently swept tenant", async () => {
    let clock = Date.parse("2026-08-20T00:00:00.000Z");
    const { fleet, autopilot } = await fixture(() => [], { maxTenantsPerSweep: 1 }, () => (clock += 1000));
    await fleet.enroll({ tenantId: "low", priority: 1 });
    await fleet.enroll({ tenantId: "high-a", priority: 5 });
    await fleet.enroll({ tenantId: "high-b", priority: 5 });
    await fleet.sweep();
    await fleet.sweep();
    await fleet.sweep();
    await fleet.sweep();
    // Both high-priority tenants are served before the low band, and neither one starves the other.
    expect(autopilot.calls).toEqual(["high-a", "high-b", "high-a", "high-b"]);
  });

  it("caps how many runs a single tenant may contribute to one sweep", async () => {
    const { fleet } = await fixture((tenantId) => [run(tenantId), run(tenantId), run(tenantId), run(tenantId), run(tenantId)]);
    await fleet.enroll({ tenantId: "alpha", maxRunsPerSweep: 2 });
    const sweep = await fleet.sweep();
    expect(sweep.totalRuns).toBe(2);
    expect(sweep.results[0]?.detail).toContain("beyond sweep cap");
  });

  it("isolates a throwing tenant so the rest of the fleet still runs", async () => {
    const { fleet } = await fixture((tenantId) => {
      if (tenantId === "broken") throw new Error("autopilot exploded");
      return [run(tenantId)];
    });
    await fleet.enroll({ tenantId: "broken" });
    await fleet.enroll({ tenantId: "healthy" });
    const sweep = await fleet.sweep();
    const outcomes = Object.fromEntries(sweep.results.map((item) => [item.tenantId, item.outcome]));
    expect(outcomes).toEqual({ broken: "failed", healthy: "ran" });
    expect(sweep.totalRuns).toBe(1);
    expect(sweep.results.find((item) => item.tenantId === "broken")?.detail).toContain("autopilot exploded");
  });

  it("opens a circuit breaker after repeated failures and an operator can resume", async () => {
    let clock = Date.parse("2026-08-20T00:00:00.000Z");
    const { fleet, autopilot } = await fixture((tenantId) => {
      if (tenantId === "broken") throw new Error("still broken");
      return [run(tenantId)];
    }, {}, () => (clock += 1000));
    await fleet.enroll({ tenantId: "broken" });
    await fleet.sweep();
    await fleet.sweep();
    await fleet.sweep();
    const paused = await fleet.member("broken");
    expect(paused?.consecutiveFailures).toBe(3);
    expect(paused?.pausedUntil).toBeTruthy();
    expect(paused?.pauseReason).toContain("Circuit breaker");

    const callsBefore = autopilot.calls.length;
    await fleet.sweep();
    expect(autopilot.calls.length).toBe(callsBefore);

    const resumed = await fleet.resume("broken");
    expect(resumed.pausedUntil).toBeUndefined();
    expect(resumed.consecutiveFailures).toBe(0);
    await fleet.sweep();
    expect(autopilot.calls.length).toBe(callsBefore + 1);
  });

  it("clears the failure counter once a tenant sweeps cleanly again", async () => {
    let call = 0;
    const { fleet } = await fixture((tenantId) => {
      call++;
      if (call === 1) return [run(tenantId, "failed")];
      return [run(tenantId)];
    });
    await fleet.enroll({ tenantId: "alpha" });
    await fleet.sweep();
    expect((await fleet.member("alpha"))?.consecutiveFailures).toBe(1);
    await fleet.sweep();
    expect((await fleet.member("alpha"))?.consecutiveFailures).toBe(0);
  });

  it("enforces the daily sweep ceiling", async () => {
    const { fleet, autopilot } = await fixture(() => [], { maxSweepsPerDay: 2 });
    await fleet.enroll({ tenantId: "alpha" });
    await fleet.sweep();
    await fleet.sweep();
    const third = await fleet.sweep();
    expect(third.sweptTenants).toBe(0);
    expect(autopilot.calls.length).toBe(2);
  });

  it("reports fleet-wide status and a durable sweep ledger", async () => {
    const { fleet } = await fixture((tenantId) => (tenantId === "beta" ? [run(tenantId, "failed")] : [run(tenantId)]));
    await fleet.enroll({ tenantId: "alpha", priority: 4 });
    await fleet.enroll({ tenantId: "beta" });
    await fleet.sweep();
    const status = await fleet.status();
    expect(status.enrolled).toBe(2);
    expect(status.enabled).toBe(2);
    expect(status.driverRunning).toBe(false);
    expect(status.runsLastSweeps).toBe(2);
    expect(status.failureRate).toBeCloseTo(0.5, 5);
    expect(status.lastSweep?.sweptTenants).toBe(2);
    const sweeps = await fleet.sweeps(5);
    expect(sweeps.length).toBe(1);
    expect(sweeps[0]?.results.length).toBe(2);
  });

  it("joins a single tenant's membership with its own autopilot health", async () => {
    const { fleet } = await fixture(() => []);
    await fleet.enroll({ tenantId: "alpha" });
    const scoped = await fleet.tenantStatus("alpha");
    expect(scoped.enrolled).toBe(true);
    expect(scoped.paused).toBe(false);
    expect(scoped.autopilot.tenantId).toBe("alpha");
    const unknown = await fleet.tenantStatus("nobody");
    expect(unknown.enrolled).toBe(false);
    expect(unknown.member).toBeUndefined();
  });

  it("can sweep one named tenant without touching the others", async () => {
    const { fleet, autopilot } = await fixture(() => []);
    await fleet.enroll({ tenantId: "alpha" });
    await fleet.enroll({ tenantId: "beta" });
    await fleet.sweep({ tenantId: "beta" });
    expect(autopilot.calls).toEqual(["beta"]);
  });

  it("rejects invalid enrollment settings", async () => {
    const { fleet } = await fixture(() => []);
    await expect(fleet.enroll({ tenantId: "   " })).rejects.toThrow(/Tenant ID/);
    await expect(fleet.enroll({ tenantId: "alpha", priority: 9 })).rejects.toThrow(/Fleet priority/);
    await expect(fleet.enroll({ tenantId: "alpha", maxRunsPerSweep: 0 })).rejects.toThrow(/Fleet runs per sweep/);
  });
});
