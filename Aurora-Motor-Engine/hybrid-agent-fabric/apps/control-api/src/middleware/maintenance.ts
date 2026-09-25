/**
 * Maintenance mode.
 *
 * Draining traffic during a migration used to mean stopping the process, which
 * also stops everything that answers "is it up?". This answers 503 with a
 * documented code instead, so a client can tell "come back later" from "the
 * server is broken", and an operator can flip it without a restart.
 *
 * Health, the root page and the maintenance endpoints themselves stay reachable
 * on purpose: a mode you cannot inspect or leave is a mode you get stuck in.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "./error-handler.js";

export interface MaintenanceState {
  enabled: boolean;
  since?: string | undefined;
  message?: string | undefined;
}

export function registerMaintenance(app: FastifyInstance, initial: MaintenanceState = { enabled: false }): MaintenanceState {
  // A caller that says "start in maintenance" should not also have to remember
  // to stamp the time: without `since` a client has no way to estimate how long
  // the window has been open.
  const state: MaintenanceState = {
    ...initial,
    ...(initial.enabled && !initial.since ? { since: new Date().toISOString() } : {}),
  };

  // Registered as the first onRequest hook, so it runs before authentication:
  // during maintenance the answer is "come back later" for everyone, and making
  // a caller authenticate to be told that just adds a failure mode.
  app.addHook("onRequest", async (request) => {
    if (!state.enabled) return;
    const url = request.url;
    if (url === "/" || url.startsWith("/health") || url.startsWith("/v1/system/maintenance")) return;
    throw new AppError("SYSTEM_MAINTENANCE", {
      ...(state.since ? { since: state.since } : {}),
      ...(state.message ? { message: state.message } : {}),
    });
  });

  app.get("/v1/system/maintenance", async () => snapshot(state));

  app.post("/v1/system/maintenance", async (request, reply) => {
    const body = z.object({
      enabled: z.boolean(),
      message: z.string().min(1).max(2000).optional(),
    }).parse(request.body);
    state.enabled = body.enabled;
    state.since = body.enabled ? new Date().toISOString() : undefined;
    state.message = body.enabled ? body.message : undefined;
    request.log.warn({ enabled: state.enabled }, "maintenance mode changed");
    return await reply.code(200).send(snapshot(state));
  });

  return state;
}

function snapshot(state: MaintenanceState): MaintenanceState {
  return {
    enabled: state.enabled,
    ...(state.since ? { since: state.since } : {}),
    ...(state.message ? { message: state.message } : {}),
  };
}
