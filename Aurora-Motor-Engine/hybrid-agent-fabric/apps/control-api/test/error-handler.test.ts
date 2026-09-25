/**
 * Error Handler Tests
 */

import { describe, it, expect } from "vitest";
import { ErrorCodes, AppError, ValidationError, NotFoundError, ConflictError, registerErrorHandler } from "../src/middleware/error-handler.js";
import Fastify from "fastify";
import { SessionAlreadyExistsError, SessionNotFoundError } from "@haf/engine";

describe("Error Codes", () => {
  it("should have auth error codes", () => {
    expect(ErrorCodes.AUTH_TOKEN_INVALID.code).toBe("HAF-1001");
    expect(ErrorCodes.AUTH_TOKEN_INVALID.status).toBe(401);
    expect(ErrorCodes.AUTH_TOKEN_EXPIRED.code).toBe("HAF-1002");
    expect(ErrorCodes.AUTH_CSRF_INVALID.code).toBe("HAF-1005");
    expect(ErrorCodes.AUTH_RATE_LIMITED.code).toBe("HAF-1009");
  });

  it("should have validation error codes", () => {
    expect(ErrorCodes.VALIDATION_BODY.code).toBe("HAF-2001");
    expect(ErrorCodes.VALIDATION_BODY.status).toBe(400);
    expect(ErrorCodes.VALIDATION_FILE_TOO_LARGE.code).toBe("HAF-2005");
    expect(ErrorCodes.VALIDATION_FILE_TOO_LARGE.status).toBe(413);
  });

  it("should have session error codes", () => {
    expect(ErrorCodes.SESSION_NOT_FOUND.code).toBe("HAF-3001");
    expect(ErrorCodes.SESSION_NOT_FOUND.status).toBe(404);
    expect(ErrorCodes.SESSION_BUDGET_EXCEEDED.code).toBe("HAF-3004");
    expect(ErrorCodes.SESSION_BUDGET_EXCEEDED.status).toBe(429);
  });

  it("should have aurora error codes", () => {
    expect(ErrorCodes.AURORA_MEMORY_ERROR.code).toBe("HAF-4001");
    expect(ErrorCodes.AURORA_WORLD_MODEL_ERROR.code).toBe("HAF-4002");
    expect(ErrorCodes.AURORA_CONSTITUTION_VIOLATION.code).toBe("HAF-4007");
    expect(ErrorCodes.AURORA_CONSTITUTION_VIOLATION.status).toBe(403);
  });

  it("should have platform error codes", () => {
    expect(ErrorCodes.PLATFORM_NOT_FOUND.code).toBe("HAF-5001");
    expect(ErrorCodes.PLATFORM_WEBHOOK_INVALID.code).toBe("HAF-5002");
  });

  it("should have model error codes", () => {
    expect(ErrorCodes.MODEL_NOT_FOUND.code).toBe("HAF-6001");
    expect(ErrorCodes.MODEL_RATE_LIMITED.code).toBe("HAF-6003");
    expect(ErrorCodes.MODEL_CONTEXT_TOO_LONG.code).toBe("HAF-6004");
    expect(ErrorCodes.MODEL_CONTEXT_TOO_LONG.status).toBe(400);
  });

  it("should have resource error codes", () => {
    expect(ErrorCodes.RESOURCE_NOT_FOUND.code).toBe("HAF-7001");
    expect(ErrorCodes.RESOURCE_CONFLICT.code).toBe("HAF-7002");
    expect(ErrorCodes.RESOURCE_LOCKED.code).toBe("HAF-7003");
    expect(ErrorCodes.RESOURCE_LOCKED.status).toBe(423);
  });

  it("should have system error codes", () => {
    expect(ErrorCodes.SYSTEM_INTERNAL.code).toBe("HAF-8001");
    expect(ErrorCodes.SYSTEM_INTERNAL.status).toBe(500);
    expect(ErrorCodes.SYSTEM_SERVICE_UNAVAILABLE.code).toBe("HAF-8002");
    expect(ErrorCodes.SYSTEM_TIMEOUT.code).toBe("HAF-8003");
  });
});

describe("AppError", () => {
  it("should create error with correct properties", () => {
    const error = new AppError("AUTH_TOKEN_INVALID", { token: "abc" });
    expect(error.code).toBe("HAF-1001");
    expect(error.status).toBe(401);
    expect(error.message).toBe("Invalid authentication token");
    expect(error.details).toEqual({ token: "abc" });
    expect(error.isOperational).toBe(true);
  });

  it("should be instanceof Error", () => {
    const error = new AppError("SYSTEM_INTERNAL");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
  });
});

describe("ValidationError", () => {
  it("should create validation error", () => {
    const error = new ValidationError("email", "Invalid email format");
    expect(error.code).toBe("HAF-2001");
    expect(error.status).toBe(400);
    expect(error.details).toEqual({
      field: "email",
      message: "Invalid email format",
    });
  });
});

describe("NotFoundError", () => {
  it("should create not found error", () => {
    const error = new NotFoundError("Session", "abc-123");
    expect(error.code).toBe("HAF-7001");
    expect(error.status).toBe(404);
    expect(error.details).toEqual({
      resource: "Session",
      id: "abc-123",
    });
  });
});

describe("ConflictError", () => {
  it("should create conflict error", () => {
    const error = new ConflictError("Session", "Session already closed");
    expect(error.code).toBe("HAF-7002");
    expect(error.status).toBe(409);
    expect(error.details).toEqual({
      resource: "Session",
      message: "Session already closed",
    });
  });
});

describe("engine session errors reach the client with the documented status", () => {
  // The registry asserted HAF-3001 existed; nothing asserted it was ever
  // returned. A missing session arrived as a plain Error and fell through to the
  // 500 fallback, so the documented response was not the one a client got. These
  // drive the real handler over a real Fastify instance.
  async function appWith(thrower: () => Promise<never>) {
    const app = Fastify({ logger: false });
    await registerErrorHandler(app);
    app.get("/v1/sessions/:sessionId/instructions", thrower);
    return app;
  }

  it("answers 404 with HAF-3001 for a session that does not exist", async () => {
    const app = await appWith(async () => {
      throw new SessionNotFoundError("missing-42");
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/sessions/missing-42/instructions",
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe("HAF-3001");
      expect(body.error.details.sessionId).toBe("missing-42");
    } finally {
      await app.close();
    }
  });

  it("answers 404 for a catalogued session that has no snapshot", async () => {
    const app = await appWith(async () => {
      throw new SessionNotFoundError("half-built", "no-snapshot");
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/sessions/half-built/instructions",
      });

      // Still a 404: from outside there is nothing usable at that id.
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("HAF-3001");
    } finally {
      await app.close();
    }
  });

  it("answers 409 with HAF-3006 when the id is already taken", async () => {
    const app = await appWith(async () => {
      throw new SessionAlreadyExistsError("taken-1");
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/sessions/taken-1/instructions",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("HAF-3006");
    } finally {
      await app.close();
    }
  });

  it("still answers 500 for an error nobody has classified", async () => {
    // The translation must be specific. Turning every engine error into a 404
    // would hide real failures behind a "not found".
    const app = await appWith(async () => {
      throw new Error("something genuinely broke");
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/sessions/whatever/instructions",
      });

      expect(response.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
});
