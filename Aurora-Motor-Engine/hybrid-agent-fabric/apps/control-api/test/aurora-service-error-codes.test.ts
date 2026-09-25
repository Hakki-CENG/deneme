/**
 * Per-service Aurora error typing.
 *
 * `AURORA_INITIATIVE_ERROR`, `AURORA_EVOLUTION_ERROR` and
 * `AURORA_COGNITIVE_ERROR` were registered and never produced, because the
 * services behind these routes throw plain `Error`s: a cognitive-orchestrator
 * failure and an initiative-engine failure reached the client as the same
 * undifferentiated 500.
 *
 * These tests register the real `onRoute` hook on a real Fastify instance and
 * assert both halves of the contract: the service is named correctly, and
 * errors that were already typed are left alone.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, ErrorCodes, registerErrorHandler } from "../src/middleware/error-handler.js";
import { registerAuroraServiceErrorTyping } from "../src/routes/aurora-service-errors.js";

async function app(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await registerErrorHandler(instance);
  registerAuroraServiceErrorTyping(instance);
  return instance;
}

describe("aurora service error codes", () => {
  it("names the service that failed instead of answering a generic 500", async () => {
    const instance = await app();
    instance.get("/v1/cognitive/cycle", async () => {
      throw new Error("workspace graph is inconsistent");
    });
    instance.post("/v1/initiative/propose", async () => {
      throw new Error("worthiness scoring failed");
    });
    instance.get("/v1/evolution/candidates", async () => {
      throw new Error("population is empty");
    });

    const cognitive = await instance.inject({ method: "GET", url: "/v1/cognitive/cycle" });
    expect(cognitive.statusCode).toBe(ErrorCodes.AURORA_COGNITIVE_ERROR.status);
    expect(cognitive.json().error.code).toBe("HAF-4005");
    expect(cognitive.json().error.details.route).toBe("/v1/cognitive/cycle");
    expect(cognitive.json().error.details.reason).toBe("workspace graph is inconsistent");
    // The documented message stays generic: internal wording is not the
    // contract, and leaking it in the message field is how internals escape.
    expect(cognitive.json().error.message).toBe("Cognitive orchestrator error");

    const initiative = await instance.inject({ method: "POST", url: "/v1/initiative/propose" });
    expect(initiative.json().error.code).toBe("HAF-4003");

    const evolution = await instance.inject({ method: "GET", url: "/v1/evolution/candidates" });
    expect(evolution.json().error.code).toBe("HAF-4004");
    await instance.close();
  });

  it("leaves a validation failure a 400 about the request, not a 500 about the service", async () => {
    const instance = await app();
    instance.post("/v1/cognitive/intake", async (request) => {
      return z.object({ title: z.string().min(1) }).parse(request.body);
    });

    const response = await instance.inject({ method: "POST", url: "/v1/cognitive/intake", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("HAF-2001");
    await instance.close();
  });

  it("passes an already-typed error through untouched", async () => {
    const instance = await app();
    instance.get("/v1/cognitive/things/:id", async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      throw new AppError("RESOURCE_NOT_FOUND", { resource: "cognitive-thing", id });
    });

    const response = await instance.inject({ method: "GET", url: "/v1/cognitive/things/abc" });
    expect(response.statusCode).toBe(ErrorCodes.RESOURCE_NOT_FOUND.status);
    expect(response.json().error.code).toBe("HAF-7001");
    await instance.close();
  });

  it("does not touch routes outside the mapped services", async () => {
    const instance = await app();
    instance.get("/v1/sessions", async () => {
      throw new Error("session store unavailable");
    });

    const response = await instance.inject({ method: "GET", url: "/v1/sessions" });
    expect(response.statusCode).toBe(ErrorCodes.SYSTEM_INTERNAL.status);
    expect(response.json().error.code).toBe("HAF-8001");
    await instance.close();
  });

  it("maps by whole path segment, so a prefix lookalike is not swept in", async () => {
    const instance = await app();
    // `/v1/cognitive-health` starts with the cognitive prefix but is not the
    // cognitive service; a loose pattern would mislabel its failures.
    instance.get("/v1/cognitive-health", async () => {
      throw new Error("probe failed");
    });

    const response = await instance.inject({ method: "GET", url: "/v1/cognitive-health" });
    expect(response.json().error.code).toBe("HAF-8001");
    await instance.close();
  });
});
