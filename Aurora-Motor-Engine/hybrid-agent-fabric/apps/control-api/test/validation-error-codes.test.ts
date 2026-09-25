/**
 * Validation errors must say which part of the request was wrong.
 *
 * The handler answered `HAF-2001` ("body") for every Fastify validation failure,
 * so a client with a bad query string was told its body was wrong. Four codes
 * for query, params and headers existed in the registry and none of them was
 * ever produced. These drive real schema validation over a real Fastify instance
 * and assert the code a client actually receives.
 */

import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ErrorCodes, registerErrorHandler } from "../src/middleware/error-handler.js";

async function appWithSchemas(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerErrorHandler(app);

  app.post("/body", {
    schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  }, async () => ({ ok: true }));

  app.get("/query", {
    schema: { querystring: { type: "object", required: ["page"], properties: { page: { type: "integer" } } } },
  }, async () => ({ ok: true }));

  app.get("/params/:id", {
    schema: { params: { type: "object", properties: { id: { type: "integer" } } } },
  }, async () => ({ ok: true }));

  app.get("/headers", {
    schema: { headers: { type: "object", required: ["x-tenant"], properties: { "x-tenant": { type: "string" } } } },
  }, async () => ({ ok: true }));

  return app;
}

describe("each validation failure names its own part of the request", () => {
  it("answers HAF-2001 for a bad body", async () => {
    const app = await appWithSchemas();
    try {
      const response = await app.inject({ method: "POST", url: "/body", payload: {} });

      expect(response.statusCode).toBe(ErrorCodes.VALIDATION_BODY.status);
      expect(response.json().error.code).toBe("HAF-2001");
    } finally {
      await app.close();
    }
  });

  it("answers HAF-2002 for a bad query string, not a bad body", async () => {
    const app = await appWithSchemas();
    try {
      const response = await app.inject({ method: "GET", url: "/query?page=not-a-number" });

      expect(response.statusCode).toBe(ErrorCodes.VALIDATION_QUERY.status);
      expect(response.json().error.code).toBe("HAF-2002");
    } finally {
      await app.close();
    }
  });

  it("answers HAF-2003 for bad path parameters", async () => {
    const app = await appWithSchemas();
    try {
      const response = await app.inject({ method: "GET", url: "/params/not-a-number" });

      expect(response.statusCode).toBe(ErrorCodes.VALIDATION_PARAMS.status);
      expect(response.json().error.code).toBe("HAF-2003");
    } finally {
      await app.close();
    }
  });

  it("answers HAF-2004 for missing required headers", async () => {
    const app = await appWithSchemas();
    try {
      const response = await app.inject({ method: "GET", url: "/headers" });

      expect(response.statusCode).toBe(ErrorCodes.VALIDATION_HEADERS.status);
      expect(response.json().error.code).toBe("HAF-2004");
    } finally {
      await app.close();
    }
  });

  it("answers 415 HAF-2006 for a content type the server will not parse", async () => {
    // `text/plain` is deliberately not used: Fastify parses that by default, so
    // the body schema fails first and the response is a 400 about the body --
    // correct, but not the case under test. `application/xml` has no parser.
    const app = await appWithSchemas();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/body",
        headers: { "content-type": "application/xml" },
        payload: "<name>x</name>",
      });

      expect(response.statusCode).toBe(ErrorCodes.VALIDATION_UNSUPPORTED_MEDIA.status);
      expect(response.json().error.code).toBe("HAF-2006");
    } finally {
      await app.close();
    }
  });

  it("still answers 200 when the request is valid", async () => {
    // A guard against the mapping turning every request into an error.
    const app = await appWithSchemas();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/body",
        payload: { name: "fine" },
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
