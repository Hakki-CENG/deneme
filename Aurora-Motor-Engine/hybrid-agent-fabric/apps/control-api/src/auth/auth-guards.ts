/**
 * Request guards: who is calling, and are they allowed to.
 *
 * Extracted from `main.ts` so the behaviour is reachable from a test. Inline in
 * a 3,500-line entrypoint that listens on a port at import time, these hooks
 * could only be exercised by starting the whole server — which is why five
 * registered auth codes went unproduced and unnoticed.
 *
 * The codes produced here, and the condition behind each:
 *
 * | Code | Condition |
 * |---|---|
 * | `AUTH_SESSION_NOT_FOUND` | no bearer token, no usable session cookie, anonymous mode off |
 * | `AUTH_SESSION_EXPIRED` | a cookie that names a session which has lapsed |
 * | `AUTH_SYSTEM_ADMIN_REQUIRED` | a system-scoped route called by a non-system-admin |
 * | `AUTH_INSUFFICIENT_ROLE` | the caller's role in the resolved tenant is below the route's requirement |
 * | `AUTH_CSRF_INVALID` | an unsafe method from a cookie session without a matching CSRF header |
 *
 * All five are thrown as `AppError` rather than answered with an inline
 * `reply.send`. An inline answer bypasses the central error handler, so the body
 * is whatever the hook happened to write and the documented code is never sent.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { HybridAgentEngine } from "@haf/engine";
import { AppError } from "../middleware/error-handler.js";
import { roleAllows, type Identity, type IdentityService, type Role, type WebSession } from "./identity-service.js";

export interface AuthGuardOptions {
  identityService: IdentityService;
  cookieName: string;
  engine: HybridAgentEngine;
  oidcConfigured: boolean;
}

export interface AuthRequestState {
  identity(request: FastifyRequest): Identity | undefined;
  webSession(request: FastifyRequest): WebSession | undefined;
}

/** Routes an unauthenticated caller may reach. */
export function isPublicWebhook(url: string): boolean {
  return (
    /^\/v1\/automations\/[^/]+\/webhook(?:\?|$)/.test(url) ||
    /^\/v1\/automation-responders\/[^/]+\/(?:heartbeat|events)(?:\?|$)/.test(url) ||
    /^\/v1\/cron\/fire(?:\?|$)/.test(url) ||
    /^\/v1\/platforms\/(?:telegram|slack|discord|whatsapp|signal|matrix|mattermost|line|google-chat|teams|feishu|github-app|twilio)\/webhook(?:\?|$)/.test(url)
  );
}

export function isPublicRoute(url: string): boolean {
  return url === "/" || url.startsWith("/canvas") || url.startsWith("/health") || url.startsWith("/auth/") || isPublicWebhook(url);
}

/** Path prefixes that manage the whole installation rather than one tenant. */
const SYSTEM_ADMIN_PATH = /^\/v1\/(?:backends|mcp|plugins|detached-workers|skills\/hub|model-configurations|model-auth|providers\/[^/]+\/credentials|secret-sources|aurora\/fleet)/;

/** Admin-scoped mutations: anything under these prefixes that is not a safe method. */
const ADMIN_MUTATION_PATH = /^\/v1\/(?:secrets|learning|agent-profiles|repositories|repository-providers|github-apps|model-oauth-sources|automation-git-sources|automation-responders|society|cognitive|memory-graph|world|multiworld|initiative|user-model|evolution|environment|constitution|harness|microagents|risk|acos|decisions|plans|experience|autopilot|checkpoints|aurora|delegations|delegation-policy|harvest-review|harvest-policy|decision-feedback|estimation|hooks|session-modes|session-archives|model-prices|effort-defaults|trust|questions|auto-approvals|session-budgets|verification|channel-routing-rules)/;

/**
 * Path-scoped resources whose tenant comes from the record, not from the caller.
 *
 * Reading the tenant from the request would let a caller name any tenant they
 * like; resolving it from the stored record is what makes the role check below
 * mean something for `GET /v1/sessions/<someone-elses-id>`.
 */
async function resolveTenantId(request: FastifyRequest, engine: HybridAgentEngine, identityTenant: string): Promise<string> {
  const sessionMatch = request.url.match(/^\/v1\/sessions\/([^/?]+)/);
  if (sessionMatch) return (await engine.session(decodeURIComponent(sessionMatch[1]!))).tenantId;
  const automationMatch = request.url.match(/^\/v1\/automations\/([^/?]+)/);
  if (automationMatch) return (await engine.automations.get(decodeURIComponent(automationMatch[1]!))).tenantId;
  const learningMatch = request.url.match(/^\/v1\/learning\/candidates\/([^/?]+)/);
  if (learningMatch) return (await engine.learning.get(decodeURIComponent(learningMatch[1]!))).tenantId;
  const refinementMatch = request.url.match(/^\/v1\/learning\/refinements\/([^/?]+)/);
  if (refinementMatch && refinementMatch[1] !== "plan") return (await engine.refinements.get(decodeURIComponent(refinementMatch[1]!))).tenantId;
  const agentProfileMatch = request.url.match(/^\/v1\/agent-profiles\/([^/?]+)/);
  if (agentProfileMatch) return (await engine.agentProfiles.get(decodeURIComponent(agentProfileMatch[1]!))).tenantId;
  return identityTenant;
}

export function registerAuthGuards(app: FastifyInstance, options: AuthGuardOptions): AuthRequestState {
  const { identityService, cookieName, engine, oidcConfigured } = options;
  const requestIdentity = new WeakMap<object, Identity>();
  const requestWebSession = new WeakMap<object, WebSession>();

  app.addHook("onRequest", async (request) => {
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    let identity = identityService.apiTokenIdentity(bearer);
    let webSession: WebSession | undefined;
    if (!identity) {
      // A cookie that names an expired session is answered differently from no
      // cookie at all: the first means "log in again", the second means "you were
      // never logged in". Collapsing them is what makes a client retry a dead
      // credential forever.
      const lookup = await identityService.lookupSession(request.cookies[cookieName]);
      if (lookup.status === "active") {
        webSession = lookup.session;
        identity = webSession.identity;
      } else if (lookup.status === "expired" && !isPublicRoute(request.url)) {
        throw new AppError("AUTH_SESSION_EXPIRED", { expiredAt: lookup.expiresAt });
      }
    }
    identity ??= identityService.anonymousIdentity();
    if (identity) requestIdentity.set(request, identity);
    if (webSession) requestWebSession.set(request, webSession);
    if (!isPublicRoute(request.url) && !identity) {
      // `AUTH_SESSION_NOT_FOUND` is the code for "we cannot resolve who you
      // are". The distinction between an anonymous-mode server and a missing
      // credential is carried in `details`, not in a second status code.
      throw new AppError("AUTH_SESSION_NOT_FOUND", {
        authType: "anonymous",
        login: oidcConfigured ? "/auth/oidc/start" : "/auth/login/token",
      });
    }
  });

  app.addHook("preHandler", async (request) => {
    // Fastify applies root-level hooks to the not-found handler as well, so this
    // hook also runs for URLs that match no route at all. The tenant lookups
    // below resolve a path-scoped id and throw when it is missing, which turned
    // "there is no such route" into a 500: `GET /v1/sessions/<unknown-id>/anything`
    // answered 500 for every suffix, existing route or not. There is nothing to
    // authorize when no route matched, so step aside and let Fastify answer 404.
    // Measured: routeOptions.url is undefined exactly when routing did not match.
    if (typeof request.routeOptions?.url !== "string") return;
    if (!request.url.startsWith("/v1") || isPublicWebhook(request.url)) return;
    const identity = requestIdentity.get(request);
    if (!identity) throw new AppError("AUTH_SESSION_NOT_FOUND", { authType: "anonymous" });

    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    const query = request.query && typeof request.query === "object" ? (request.query as Record<string, unknown>) : {};
    const declared = String(request.headers["x-haf-tenant"] ?? body.tenantId ?? query.tenantId ?? process.env.HAF_DEFAULT_TENANT ?? "local");
    const tenantId = await resolveTenantId(request, engine, declared);

    if (SYSTEM_ADMIN_PATH.test(request.url) && !identity.systemAdmin) {
      throw new AppError("AUTH_SYSTEM_ADMIN_REQUIRED", {
        subject: identity.subject,
        authType: identity.authType,
      });
    }

    const methodIsSafe = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
    const required: Role = methodIsSafe ? "viewer" : ADMIN_MUTATION_PATH.test(request.url) ? "admin" : "operator";
    const heldRole = identityService.roleFor(identity, tenantId);
    if (!roleAllows(heldRole, required)) {
      throw new AppError("AUTH_INSUFFICIENT_ROLE", {
        tenantId,
        requiredRole: required,
        heldRole: heldRole ?? null,
      });
    }

    const webSession = requestWebSession.get(request);
    if (!methodIsSafe && webSession && request.headers["x-haf-csrf"] !== webSession.csrfToken) {
      throw new AppError("AUTH_CSRF_INVALID", { method: request.method });
    }
  });

  return {
    identity: (request) => requestIdentity.get(request),
    webSession: (request) => requestWebSession.get(request),
  };
}
