/**
 * The session, platform, dependency and maintenance codes, end to end.
 *
 * Each of these was registered in the error-code registry and nothing produced
 * it, so the documented response was not the one a client got. These tests drive
 * the real Fastify error handler with the real engine error classes and assert
 * the code and status a client actually receives.
 *
 * The `SESSION_ALREADY_CLOSED` case goes one step further and uses a real
 * `HybridAgentEngine`: a prompt to a closed session used to answer HTTP 200 with
 * the refusal buried in the body, so the code could not be produced at all until
 * the route translated the structured refusal.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ChannelDeliveryError,
  HybridAgentEngine,
  SessionBudgetExceededError,
  SessionLimitError,
  type SessionBudgetVerdict,
} from "@haf/engine";
import { AppError, ErrorCodes, registerErrorHandler } from "../src/middleware/error-handler.js";

async function app(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await registerErrorHandler(instance);
  return instance;
}

describe("session codes", () => {
  it("answers 429 SESSION_LIMIT_EXCEEDED and says which fan-out cap fired", async () => {
    const instance = await app();
    instance.get("/spawn", async () => {
      throw new SessionLimitError("session-1", "concurrency", "2 child agent(s) are already live, at the concurrency limit of 2.", {
        maxConcurrentChildren: 2,
        maxDepth: 3,
        maxLifetimeChildren: 200,
      });
    });

    const response = await instance.inject({ method: "GET", url: "/spawn" });
    expect(response.statusCode).toBe(ErrorCodes.SESSION_LIMIT_EXCEEDED.status);
    expect(response.json().error.code).toBe("HAF-3003");
    expect(response.json().error.details.limit).toBe("concurrency");
    expect(response.json().error.details.limits.maxConcurrentChildren).toBe(2);
    await instance.close();
  });

  it("answers 429 SESSION_BUDGET_EXCEEDED with the numbers behind the refusal", async () => {
    const verdict: SessionBudgetVerdict = {
      tenantId: "local",
      sessionId: "session-1",
      state: "exhausted",
      source: "session",
      limits: { maxTokens: 1000, warnAtFraction: 0.8, onExceeded: "block" },
      spentUsd: 0.02,
      totalTokens: 1500,
      consumedFraction: 1.5,
      remainingTokens: 0,
      blocked: true,
      message: "Session budget exhausted: 1500 tokens against a cap of 1000.",
    };
    const instance = await app();
    instance.get("/turn", async () => {
      throw new SessionBudgetExceededError(verdict);
    });

    const response = await instance.inject({ method: "GET", url: "/turn" });
    expect(response.statusCode).toBe(ErrorCodes.SESSION_BUDGET_EXCEEDED.status);
    expect(response.json().error.code).toBe("HAF-3004");
    expect(response.json().error.details.state).toBe("exhausted");
    expect(response.json().error.details.totalTokens).toBe(1500);
    expect(response.json().error.details.limits.maxTokens).toBe(1000);
    await instance.close();
  });

  it("answers 409 SESSION_ALREADY_CLOSED for a prompt to a really closed session", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "haf-closed-session-"));
    const engine = new HybridAgentEngine({
      homePath,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    const session = await engine.createSession({ tenantId: "local", name: "worker" });
    await engine.closeSession(session.sessionId);

    // This mirrors the `/v1/sessions/:id/commands` route, which is the only HTTP
    // surface that reaches the refusal: a command refusal is a result, not a
    // throw, so the route has to translate it or the client gets a 200.
    const instance = await app();
    instance.post("/v1/sessions/:sessionId/commands", async (request) => {
      const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
      const body = z.object({ kind: z.string(), text: z.string() }).parse(request.body);
      const result = await engine.command({
        protocolVersion: 1,
        commandId: randomUUID(),
        clientId: "test",
        tenantId: "local",
        sessionId,
        kind: "session.prompt",
        source: "api",
        issuedAt: new Date().toISOString(),
        payload: { text: body.text },
      } as never);
      if (result.status === "rejected" && result.error?.code === "SESSION_NOT_RUNNABLE") {
        throw new AppError("SESSION_ALREADY_CLOSED", {
          sessionId,
          sessionState: result.error.sessionState,
          commandKind: body.kind,
        });
      }
      return result;
    });

    const response = await instance.inject({
      method: "POST",
      url: `/v1/sessions/${session.sessionId}/commands`,
      payload: { kind: "session.prompt", text: "Are you still there?" },
    });

    expect(response.statusCode).toBe(ErrorCodes.SESSION_ALREADY_CLOSED.status);
    expect(response.json().error.code).toBe("HAF-3002");
    expect(response.json().error.details.sessionState).toBe("closed");
    await instance.close();
    await engine.shutdown();
  }, 90_000);
});

describe("platform delivery codes", () => {
  async function delivering(error: ChannelDeliveryError) {
    const instance = await app();
    instance.post("/send", async () => {
      throw error;
    });
    const response = await instance.inject({ method: "POST", url: "/send" });
    await instance.close();
    return response;
  }

  it("answers 429 PLATFORM_RATE_LIMITED and forwards Retry-After", async () => {
    const response = await delivering(
      new ChannelDeliveryError("telegram", "rate-limited", "telegram delivery failed (429): Too Many Requests.", {
        destination: "chat-1",
        httpStatus: 429,
        retryAfterMs: 7000,
      }),
    );
    expect(response.statusCode).toBe(ErrorCodes.PLATFORM_RATE_LIMITED.status);
    expect(response.json().error.code).toBe("HAF-5004");
    expect(response.headers["retry-after"]).toBe("7");
    expect(response.json().error.details.platform).toBe("telegram");
    expect(response.json().error.details.upstreamStatus).toBe(429);
  });

  it("answers 429 PLATFORM_QUOTA_EXCEEDED without a Retry-After, because waiting will not help", async () => {
    const response = await delivering(
      new ChannelDeliveryError("slack", "quota-exceeded", "slack delivery failed (402): insufficient credit.", {
        destination: "C123",
        httpStatus: 402,
      }),
    );
    expect(response.statusCode).toBe(ErrorCodes.PLATFORM_QUOTA_EXCEEDED.status);
    expect(response.json().error.code).toBe("HAF-5005");
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("answers 502 PLATFORM_CONNECTION_FAILED when the platform was never reached", async () => {
    const response = await delivering(
      new ChannelDeliveryError("discord", "connection-failed", "discord could not be reached (ECONNREFUSED).", {
        destination: "chan-1",
        cause: "ECONNREFUSED",
      }),
    );
    expect(response.statusCode).toBe(ErrorCodes.PLATFORM_CONNECTION_FAILED.status);
    expect(response.json().error.code).toBe("HAF-5003");
    expect(response.json().error.details.disposition).toBe("connection-failed");
  });
});

describe("system codes", () => {
  it("answers 502 SYSTEM_DEPENDENCY_FAILED for a socket-level failure, naming the code", async () => {
    const instance = await app();
    instance.get("/github", async () => {
      // Shaped like a real `fetch` rejection: a generic wrapper with the socket
      // error on `cause`. Matching the message text would not survive undici.
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" }) });
    });

    const response = await instance.inject({ method: "GET", url: "/github" });
    expect(response.statusCode).toBe(ErrorCodes.SYSTEM_DEPENDENCY_FAILED.status);
    expect(response.json().error.code).toBe("HAF-8004");
    expect(response.json().error.details.dependencyCode).toBe("ECONNREFUSED");
    await instance.close();
  });

  it("does not call an ordinary crash a dependency failure", async () => {
    const instance = await app();
    instance.get("/boom", async () => {
      throw new Error("something internal went wrong");
    });
    const response = await instance.inject({ method: "GET", url: "/boom" });
    expect(response.statusCode).toBe(ErrorCodes.SYSTEM_INTERNAL.status);
    expect(response.json().error.code).toBe("HAF-8001");
    await instance.close();
  });
});

afterAll(() => undefined);
