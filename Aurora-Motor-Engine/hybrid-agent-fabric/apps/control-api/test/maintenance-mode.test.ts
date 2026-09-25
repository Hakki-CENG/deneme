/**
 * Maintenance mode.
 *
 * `SYSTEM_MAINTENANCE` (HAF-8005) was registered with nothing to return it:
 * there was no maintenance mode to report. Draining traffic meant stopping the
 * process, which also stops everything that answers "is it up?".
 *
 * A mode you cannot inspect or leave is a mode you get stuck in, so the two
 * properties asserted here matter more than the 503 itself: health stays
 * reachable while maintenance is on, and the toggle is reachable through the
 * gate that it controls.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { ErrorCodes, registerErrorHandler } from "../src/middleware/error-handler.js";
import { registerMaintenance } from "../src/middleware/maintenance.js";

async function app(initial: { enabled: boolean } = { enabled: false }): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await registerErrorHandler(instance);
  registerMaintenance(instance, initial);
  instance.get("/health", async () => ({ status: "ok" }));
  instance.get("/v1/things", async () => ({ ok: true }));
  return instance;
}

describe("maintenance mode", () => {
  it("passes traffic through when it is off", async () => {
    const instance = await app();
    expect((await instance.inject({ method: "GET", url: "/v1/things" })).statusCode).toBe(200);
    const status = await instance.inject({ method: "GET", url: "/v1/system/maintenance" });
    expect(status.json()).toEqual({ enabled: false });
    await instance.close();
  });

  it("answers 503 SYSTEM_MAINTENANCE for ordinary routes when it is on", async () => {
    const instance = await app({ enabled: true });
    const response = await instance.inject({ method: "GET", url: "/v1/things" });
    expect(response.statusCode).toBe(ErrorCodes.SYSTEM_MAINTENANCE.status);
    expect(response.json().error.code).toBe("HAF-8005");
    expect(response.json().error.details.since).toBeTruthy();
    await instance.close();
  });

  it("keeps health reachable while maintenance is on", async () => {
    const instance = await app({ enabled: true });
    const response = await instance.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
    await instance.close();
  });

  it("can be inspected and turned off through the gate it controls", async () => {
    const instance = await app({ enabled: true });

    const before = await instance.inject({ method: "GET", url: "/v1/system/maintenance" });
    expect(before.statusCode).toBe(200);
    expect(before.json().enabled).toBe(true);

    const off = await instance.inject({
      method: "POST",
      url: "/v1/system/maintenance",
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ enabled: false });

    expect((await instance.inject({ method: "GET", url: "/v1/things" })).statusCode).toBe(200);
    await instance.close();
  });

  it("carries an operator's message to the client, and drops it when maintenance ends", async () => {
    const instance = await app();
    await instance.inject({
      method: "POST",
      url: "/v1/system/maintenance",
      payload: { enabled: true, message: "Migrating the event store, back in ten minutes." },
    });

    const blocked = await instance.inject({ method: "GET", url: "/v1/things" });
    expect(blocked.json().error.code).toBe("HAF-8005");
    expect(blocked.json().error.details.message).toBe("Migrating the event store, back in ten minutes.");

    await instance.inject({ method: "POST", url: "/v1/system/maintenance", payload: { enabled: false } });
    const after = await instance.inject({ method: "GET", url: "/v1/system/maintenance" });
    expect(after.json()).toEqual({ enabled: false });
    await instance.close();
  });
});
