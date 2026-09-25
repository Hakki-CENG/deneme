/**
 * The auth guard codes, driven through the real guards.
 *
 * Five codes in the registry described auth outcomes the API never actually
 * reported: the guards answered with inline `reply.send({ error: "forbidden" })`
 * bodies, which bypass the central error handler, so the documented code was
 * never sent and the shape varied per hook.
 *
 * `registerAuthGuards` was extracted from `main.ts` for exactly this reason —
 * inline in a 3,500-line entrypoint that binds a port at import time, the only
 * way to exercise a hook was to start the whole server.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { HybridAgentEngine } from "@haf/engine";
import { registerAuthGuards } from "../src/auth/auth-guards.js";
import { IdentityService, type Identity } from "../src/auth/identity-service.js";
import { ErrorCodes, registerErrorHandler } from "../src/middleware/error-handler.js";

const COOKIE = "haf_session";

/**
 * Only the tenant-resolution lookups are stubbed, and only for the path shapes
 * that use them. A route outside those shapes never touches the engine, so the
 * guards under test are the real ones.
 */
const engineStub = {
  session: async () => ({ tenantId: "local" }),
  automations: { get: async () => ({ tenantId: "local" }) },
  learning: { get: async () => ({ tenantId: "local" }) },
  refinements: { get: async () => ({ tenantId: "local" }) },
  agentProfiles: { get: async () => ({ tenantId: "local" }) },
} as unknown as HybridAgentEngine;

async function guardedApp(identityService: IdentityService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await registerErrorHandler(app);
  registerAuthGuards(app, { identityService, cookieName: COOKIE, engine: engineStub, oidcConfigured: false });
  app.get("/v1/things", async () => ({ ok: true }));
  app.post("/v1/things", async () => ({ ok: true }));
  app.get("/v1/backends", async () => ({ ok: true }));
  return app;
}

async function serviceWith(identity: Identity, sessionTtlMs = 8 * 60 * 60_000) {
  const sessionFile = join(await mkdtemp(join(tmpdir(), "haf-guards-")), "sessions.enc");
  const identityService = new IdentityService({ sessionFile, sessionSecret: "test-secret", authDisabled: false, defaultTenant: "local", sessionTtlMs });
  const session = await identityService.createSession(identity);
  return { identityService, session };
}

const viewer: Identity = { subject: "user-1", authType: "oidc", systemAdmin: false, tenants: { local: "viewer" } };
const operator: Identity = { subject: "user-2", authType: "oidc", systemAdmin: false, tenants: { local: "operator" } };

describe("auth guard codes", () => {
  it("answers 401 AUTH_SESSION_NOT_FOUND when nothing identifies the caller", async () => {
    const sessionFile = join(await mkdtemp(join(tmpdir(), "haf-guards-")), "sessions.enc");
    const identityService = new IdentityService({ sessionFile, sessionSecret: "s", authDisabled: false, defaultTenant: "local" });
    const app = await guardedApp(identityService);

    const response = await app.inject({ method: "GET", url: "/v1/things" });
    expect(response.statusCode).toBe(ErrorCodes.AUTH_SESSION_NOT_FOUND.status);
    expect(response.json().error.code).toBe("HAF-1003");
    expect(response.json().error.details.login).toBe("/auth/login/token");
    await app.close();
  });

  it("answers 401 AUTH_SESSION_EXPIRED for a cookie whose session has lapsed, not the generic 401", async () => {
    const { identityService, session } = await serviceWith(viewer, 5);
    const app = await guardedApp(identityService);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const response = await app.inject({
      method: "GET",
      url: "/v1/things",
      cookies: { [COOKIE]: session.id },
    });
    expect(response.statusCode).toBe(ErrorCodes.AUTH_SESSION_EXPIRED.status);
    expect(response.json().error.code).toBe("HAF-1004");
    expect(response.json().error.details.expiredAt).toBe(session.expiresAt);
    await app.close();
  });

  it("answers 403 AUTH_SYSTEM_ADMIN_REQUIRED on a system-scoped route", async () => {
    const { identityService, session } = await serviceWith(operator);
    const app = await guardedApp(identityService);

    const response = await app.inject({
      method: "GET",
      url: "/v1/backends",
      cookies: { [COOKIE]: session.id },
    });
    expect(response.statusCode).toBe(ErrorCodes.AUTH_SYSTEM_ADMIN_REQUIRED.status);
    expect(response.json().error.code).toBe("HAF-1007");
    expect(response.json().error.details.subject).toBe("user-2");
    await app.close();
  });

  it("answers 403 AUTH_INSUFFICIENT_ROLE and reports both the held and the required role", async () => {
    const { identityService, session } = await serviceWith(viewer);
    const app = await guardedApp(identityService);

    // A viewer may read but not write: POST /v1/things requires operator.
    const allowed = await app.inject({ method: "GET", url: "/v1/things", cookies: { [COOKIE]: session.id } });
    expect(allowed.statusCode).toBe(200);

    const refused = await app.inject({
      method: "POST",
      url: "/v1/things",
      cookies: { [COOKIE]: session.id },
      headers: { "x-haf-csrf": session.csrfToken },
    });
    expect(refused.statusCode).toBe(ErrorCodes.AUTH_INSUFFICIENT_ROLE.status);
    expect(refused.json().error.code).toBe("HAF-1006");
    expect(refused.json().error.details.requiredRole).toBe("operator");
    expect(refused.json().error.details.heldRole).toBe("viewer");
    await app.close();
  });

  it("answers 403 AUTH_CSRF_INVALID for an unsafe method from a cookie session without the header", async () => {
    const { identityService, session } = await serviceWith(operator);
    const app = await guardedApp(identityService);

    const response = await app.inject({
      method: "POST",
      url: "/v1/things",
      cookies: { [COOKIE]: session.id },
    });
    expect(response.statusCode).toBe(ErrorCodes.AUTH_CSRF_INVALID.status);
    expect(response.json().error.code).toBe("HAF-1005");
    expect(response.json().error.details.method).toBe("POST");

    const withToken = await app.inject({
      method: "POST",
      url: "/v1/things",
      cookies: { [COOKIE]: session.id },
      headers: { "x-haf-csrf": session.csrfToken },
    });
    expect(withToken.statusCode).toBe(200);
    await app.close();
  });

  it("still lets a bearer token through, so the guards did not become a wall", async () => {
    const sessionFile = join(await mkdtemp(join(tmpdir(), "haf-guards-")), "sessions.enc");
    const identityService = new IdentityService({ sessionFile, sessionSecret: "s", apiToken: "admin-token", authDisabled: false, defaultTenant: "local" });
    const app = await guardedApp(identityService);

    const response = await app.inject({
      method: "GET",
      url: "/v1/things",
      headers: { authorization: "Bearer admin-token" },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("reports a session lookup as none, active or expired rather than collapsing them", async () => {
    const { identityService, session } = await serviceWith(viewer, 5);
    expect((await identityService.lookupSession(undefined)).status).toBe("none");
    expect((await identityService.lookupSession("not-a-real-session")).status).toBe("none");
    expect((await identityService.lookupSession(session.id)).status).toBe("active");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expired = await identityService.lookupSession(session.id);
    expect(expired.status).toBe("expired");
    // Reading the expiry must not destroy the record: the condition has to stay
    // observable, or the second request would report "unknown" instead.
    expect((await identityService.lookupSession(session.id)).status).toBe("expired");
  });
});
