/**
 * Centralized Error Handler
 * Semantic error codes, structured error responses, and graceful error recovery.
 * Error code format: HAF-{CATEGORY}-{NUMBER}
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ZodError } from "zod";
import {
  ChannelDeliveryError,
  ModelOAuthError,
  ModelProviderError,
  SessionAlreadyExistsError,
  SessionBudgetExceededError,
  SessionLimitError,
  SessionNotFoundError,
  SessionNotRunnableError,
} from "@haf/engine";

// ─── Error Code Registry ───

export const ErrorCodes = {
  // Auth errors (1xxx)
  AUTH_TOKEN_INVALID: { code: "HAF-1001", status: 401, message: "Invalid authentication token" },
  AUTH_TOKEN_EXPIRED: { code: "HAF-1002", status: 401, message: "Authentication token has expired" },
  AUTH_SESSION_NOT_FOUND: { code: "HAF-1003", status: 401, message: "Session not found or expired" },
  AUTH_SESSION_EXPIRED: { code: "HAF-1004", status: 401, message: "Session has expired" },
  AUTH_CSRF_INVALID: { code: "HAF-1005", status: 403, message: "CSRF token validation failed" },
  AUTH_INSUFFICIENT_ROLE: { code: "HAF-1006", status: 403, message: "Insufficient permissions for this operation" },
  AUTH_SYSTEM_ADMIN_REQUIRED: { code: "HAF-1007", status: 403, message: "System administrator access required" },
  AUTH_OIDC_ERROR: { code: "HAF-1008", status: 502, message: "OIDC authentication provider error" },
  AUTH_RATE_LIMITED: { code: "HAF-1009", status: 429, message: "Too many authentication attempts" },

  // Validation errors (2xxx)
  VALIDATION_BODY: { code: "HAF-2001", status: 400, message: "Request body validation failed" },
  VALIDATION_QUERY: { code: "HAF-2002", status: 400, message: "Query parameters validation failed" },
  VALIDATION_PARAMS: { code: "HAF-2003", status: 400, message: "Path parameters validation failed" },
  VALIDATION_HEADERS: { code: "HAF-2004", status: 400, message: "Request headers validation failed" },
  VALIDATION_FILE_TOO_LARGE: { code: "HAF-2005", status: 413, message: "File size exceeds maximum allowed" },
  VALIDATION_UNSUPPORTED_MEDIA: { code: "HAF-2006", status: 415, message: "Unsupported media type" },

  // Session errors (3xxx)
  SESSION_NOT_FOUND: { code: "HAF-3001", status: 404, message: "Session not found" },
  SESSION_ALREADY_CLOSED: { code: "HAF-3002", status: 409, message: "Session is already closed" },
  SESSION_LIMIT_EXCEEDED: { code: "HAF-3003", status: 429, message: "Maximum session limit reached" },
  SESSION_BUDGET_EXCEEDED: { code: "HAF-3004", status: 429, message: "Session token budget exceeded" },
  SESSION_EXECUTION_FAILED: { code: "HAF-3005", status: 500, message: "Session execution failed" },
  SESSION_ALREADY_EXISTS: { code: "HAF-3006", status: 409, message: "Session already exists" },

  // Aurora errors (4xxx)
  AURORA_MEMORY_ERROR: { code: "HAF-4001", status: 500, message: "Memory operation failed" },
  AURORA_WORLD_MODEL_ERROR: { code: "HAF-4002", status: 500, message: "World model operation failed" },
  AURORA_INITIATIVE_ERROR: { code: "HAF-4003", status: 500, message: "Initiative engine error" },
  AURORA_EVOLUTION_ERROR: { code: "HAF-4004", status: 500, message: "Evolution service error" },
  AURORA_COGNITIVE_ERROR: { code: "HAF-4005", status: 500, message: "Cognitive orchestrator error" },
  AURORA_CONSTITUTION_VIOLATION: { code: "HAF-4007", status: 403, message: "Action violates constitution rules" },

  // Platform errors (5xxx)
  PLATFORM_NOT_FOUND: { code: "HAF-5001", status: 404, message: "Platform not found" },
  PLATFORM_WEBHOOK_INVALID: { code: "HAF-5002", status: 400, message: "Invalid webhook signature" },
  PLATFORM_CONNECTION_FAILED: { code: "HAF-5003", status: 502, message: "Platform connection failed" },
  PLATFORM_RATE_LIMITED: { code: "HAF-5004", status: 429, message: "Platform API rate limit exceeded" },
  PLATFORM_QUOTA_EXCEEDED: { code: "HAF-5005", status: 429, message: "Platform quota exceeded" },

  // Model errors (6xxx)
  MODEL_NOT_FOUND: { code: "HAF-6001", status: 404, message: "Model not found" },
  MODEL_PROVIDER_ERROR: { code: "HAF-6002", status: 502, message: "Model provider error" },
  MODEL_RATE_LIMITED: { code: "HAF-6003", status: 429, message: "Model rate limit exceeded" },
  MODEL_CONTEXT_TOO_LONG: { code: "HAF-6004", status: 400, message: "Context exceeds model limit" },
  MODEL_AUTH_ERROR: { code: "HAF-6005", status: 401, message: "Model authentication failed" },

  // Resource errors (7xxx)
  RESOURCE_NOT_FOUND: { code: "HAF-7001", status: 404, message: "Resource not found" },
  RESOURCE_CONFLICT: { code: "HAF-7002", status: 409, message: "Resource conflict" },
  RESOURCE_LOCKED: { code: "HAF-7003", status: 423, message: "Resource is locked" },

  // System errors (8xxx)
  SYSTEM_INTERNAL: { code: "HAF-8001", status: 500, message: "Internal server error" },
  SYSTEM_SERVICE_UNAVAILABLE: { code: "HAF-8002", status: 503, message: "Service temporarily unavailable" },
  SYSTEM_TIMEOUT: { code: "HAF-8003", status: 504, message: "Request timeout" },
  SYSTEM_DEPENDENCY_FAILED: { code: "HAF-8004", status: 502, message: "External dependency failure" },
  SYSTEM_MAINTENANCE: { code: "HAF-8005", status: 503, message: "System under maintenance" },
} as const;

export type ErrorCodeKey = keyof typeof ErrorCodes;

// ─── Custom Error Classes ───

export class AppError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(errorCode: ErrorCodeKey, details?: unknown, cause?: Error) {
    const def = ErrorCodes[errorCode];
    super(def.message);
    this.name = "AppError";
    this.code = def.code;
    this.status = def.status;
    this.details = details;
    this.isOperational = true;
    if (cause) this.cause = cause;
  }
}

export class ValidationError extends AppError {
  constructor(field: string, message: string, details?: Record<string, unknown>) {
    super("VALIDATION_BODY", { field, message, ...(details ?? {}) });
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super("RESOURCE_NOT_FOUND", { resource, id });
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(resource: string, message: string) {
    super("RESOURCE_CONFLICT", { resource, message });
    this.name = "ConflictError";
  }
}

// ─── Error Response Builder ───

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
    timestamp: string;
  };
}

function buildErrorResponse(
  code: string,
  message: string,
  details?: unknown,
  requestId?: string
): ErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      ...(requestId ? { requestId } : {}),
      timestamp: new Date().toISOString(),
    },
  };
}

/** Socket-level failures that mean "the remote side was never reached". */
const DEPENDENCY_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * The socket error code behind an error, or `undefined`.
 *
 * `fetch` rejections arrive as `TypeError: fetch failed` with the real cause one
 * or more levels down, so the chain is walked rather than the top level read.
 * Bounded because a cyclic `cause` chain would otherwise hang the handler.
 */
function dependencyFailureCode(error: unknown): string | undefined {
  let current = error as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const code = current.code;
    if (typeof code === "string" && DEPENDENCY_FAILURE_CODES.has(code)) return code;
    current = current.cause as { code?: unknown; cause?: unknown } | undefined;
  }
  return undefined;
}

// ─── Error Handler Registration ───

export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(async (error: any, request, reply) => {
    const requestId = request.id;
    const timestamp = new Date().toISOString();

    // Log the error
    const logContext = {
      requestId,
      method: request.method,
      url: request.url,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      timestamp,
    };

    // ZodError - validation failure
    if (error instanceof ZodError) {
      const fieldErrors = error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
        code: e.code,
      }));

      request.log.warn({ ...logContext, errors: fieldErrors }, "Validation error");

      return await reply.code(400).send(
        buildErrorResponse(
          "HAF-2001",
          "Request validation failed",
          { fields: fieldErrors },
          requestId
        )
      );
    }

    // Engine session errors, translated to the codes this API promises.
    //
    // The engine cannot throw `AppError` -- it is a separate package -- and a
    // missing session used to arrive here as a plain `Error`, which fell through
    // to the 500 fallback. `SESSION_NOT_FOUND` (HAF-3001, 404) was defined in the
    // registry and never used by anything, so the documented response was not the
    // one a client got.
    if (error instanceof SessionNotFoundError) {
      request.log.warn({ ...logContext, sessionId: error.sessionId }, "Session not found");
      return await reply.code(ErrorCodes.SESSION_NOT_FOUND.status).send(
        buildErrorResponse(
          ErrorCodes.SESSION_NOT_FOUND.code,
          error.message,
          { sessionId: error.sessionId },
          requestId,
        ),
      );
    }

    if (error instanceof SessionAlreadyExistsError) {
      request.log.warn({ ...logContext, sessionId: error.sessionId }, "Session already exists");
      return await reply.code(409).send(
        buildErrorResponse(
          ErrorCodes.SESSION_ALREADY_EXISTS.code,
          error.message,
          { sessionId: error.sessionId },
          requestId,
        ),
      );
    }

    // Session lifecycle refusals. Each of these used to arrive as a plain
    // `Error` and fall through to the 500 fallback, so "you are posting to a
    // closed session" and "the server broke" were the same response. The codes
    // below were all registered and none was produced.
    if (error instanceof SessionNotRunnableError) {
      request.log.warn(
        { ...logContext, sessionId: error.sessionId, sessionStatus: error.sessionStatus },
        "Session cannot take new work",
      );
      const entry = ErrorCodes.SESSION_ALREADY_CLOSED;
      return await reply.code(entry.status).send(
        buildErrorResponse(
          entry.code,
          error.message,
          { sessionId: error.sessionId, sessionStatus: error.sessionStatus },
          requestId,
        ),
      );
    }

    // A fan-out cap is not a failure: the system did what it was configured to
    // do. 429 with the limit that fired, so the caller can back off or an
    // operator can raise the right knob.
    if (error instanceof SessionLimitError) {
      request.log.warn(
        { ...logContext, sessionId: error.sessionId, limit: error.limit },
        "Session fan-out limit reached",
      );
      const entry = ErrorCodes.SESSION_LIMIT_EXCEEDED;
      return await reply.code(entry.status).send(
        buildErrorResponse(
          entry.code,
          error.message,
          { sessionId: error.sessionId, limit: error.limit, limits: error.limits },
          requestId,
        ),
      );
    }

    if (error instanceof SessionBudgetExceededError) {
      const verdict = error.verdict;
      request.log.warn(
        { ...logContext, sessionId: verdict.sessionId, consumed: verdict.consumedFraction },
        "Session budget exhausted",
      );
      const entry = ErrorCodes.SESSION_BUDGET_EXCEEDED;
      return await reply.code(entry.status).send(
        buildErrorResponse(
          entry.code,
          error.message,
          {
            sessionId: verdict.sessionId,
            state: verdict.state,
            source: verdict.source,
            spentUsd: verdict.spentUsd,
            totalTokens: verdict.totalTokens,
            consumedFraction: verdict.consumedFraction,
            limits: verdict.limits,
            // An unpriced model means the money cap could not be enforced. A
            // client that is told "budget exceeded" without this would assume
            // the cap held.
            ...(verdict.unpriced ? { unpriced: true } : {}),
            ...(verdict.remainingUsd !== undefined ? { remainingUsd: verdict.remainingUsd } : {}),
            ...(verdict.remainingTokens !== undefined ? { remainingTokens: verdict.remainingTokens } : {}),
          },
          requestId,
        ),
      );
    }

    // Outbound platform delivery. One typed error, three different client
    // outcomes: honour Retry-After, stop spending, or retry later. `rejected`
    // (the platform answered and said no) shares the connection-failure code
    // because the registry has no code for it -- `details.disposition` carries
    // the distinction, which is the honest limit of what a client can act on
    // from the code alone.
    if (error instanceof ChannelDeliveryError) {
      request.log.warn(
        {
          ...logContext,
          platform: error.platform,
          disposition: error.disposition,
          httpStatus: error.detail.httpStatus,
        },
        "Platform delivery failed",
      );
      const entry =
        error.disposition === "rate-limited"
          ? ErrorCodes.PLATFORM_RATE_LIMITED
          : error.disposition === "quota-exceeded"
            ? ErrorCodes.PLATFORM_QUOTA_EXCEEDED
            : ErrorCodes.PLATFORM_CONNECTION_FAILED;
      if (error.detail.retryAfterMs !== undefined) {
        reply.header("Retry-After", Math.max(1, Math.ceil(error.detail.retryAfterMs / 1000)));
      }
      return await reply.code(entry.status).send(
        buildErrorResponse(
          entry.code,
          error.message,
          {
            platform: error.platform,
            disposition: error.disposition,
            ...(error.detail.destination ? { destination: error.detail.destination } : {}),
            ...(error.detail.httpStatus !== undefined ? { upstreamStatus: error.detail.httpStatus } : {}),
            ...(error.detail.retryAfterMs !== undefined ? { retryAfterMs: error.detail.retryAfterMs } : {}),
          },
          requestId,
        ),
      );
    }

    // Model errors from the engine.
    //
    // `MODEL_PROVIDER_ERROR` and `MODEL_AUTH_ERROR` were registered and never
    // produced, so an upstream model failure surfaced as an undifferentiated 500
    // with no provider, no retry hint and no way for a client to tell "your
    // credential is bad" from "the provider is down".
    if (error instanceof ModelOAuthError) {
      request.log.warn({ ...logContext, oauthCode: error.code }, "Model credential error");
      return await reply.code(ErrorCodes.MODEL_AUTH_ERROR.status).send(
        buildErrorResponse(
          ErrorCodes.MODEL_AUTH_ERROR.code,
          error.message,
          { oauthCode: error.code, reloginRequired: error.reloginRequired },
          requestId,
        ),
      );
    }

    if (error instanceof ModelProviderError) {
      // A credential disposition means the provider rejected our credentials,
      // which is an authentication problem the caller can act on -- not a
      // provider outage.
      const credentialFailure = error.credentialDisposition !== "none";
      const entry = credentialFailure ? ErrorCodes.MODEL_AUTH_ERROR : ErrorCodes.MODEL_PROVIDER_ERROR;
      request.log.warn(
        { ...logContext, providerId: error.providerId, code: error.code, retryable: error.retryable },
        "Model provider error",
      );
      if (error.retryAfterMs !== undefined) {
        reply.header("Retry-After", Math.ceil(error.retryAfterMs / 1000));
      }
      return await reply.code(entry.status).send(
        buildErrorResponse(
          entry.code,
          error.message,
          {
            providerId: error.providerId,
            providerCode: error.code,
            retryable: error.retryable,
            ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          },
          requestId,
        ),
      );
    }

    // AppError - known application error
    if (error instanceof AppError) {
      const logLevel = error.status >= 500 ? "error" : "warn";
      request.log[logLevel]({ ...logContext, errorCode: error.code, details: error.details }, error.message);

      return await reply.code(error.status).send(
        buildErrorResponse(error.code, error.message, error.details, requestId)
      );
    }

    // Unsupported media type. Distinct from a validation failure: the client
    // sent something the server will not even parse, so 415 rather than 400.
    if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      request.log.warn({ ...logContext }, "Unsupported media type");
      const entry = ErrorCodes.VALIDATION_UNSUPPORTED_MEDIA;
      return await reply.code(entry.status).send(
        buildErrorResponse(entry.code, entry.message, { received: error.message }, requestId)
      );
    }

    // Fastify validation error.
    //
    // `validationContext` says which part of the request failed -- 'body',
    // 'querystring', 'params' or 'headers'. This block used to answer HAF-2001
    // ("body") for all four, so a client with a bad query string was told its
    // body was wrong. The four codes already existed in the registry and none of
    // them was ever produced.
    if (error.validation) {
      const context = error.validationContext;
      const entry =
        context === "querystring"
          ? ErrorCodes.VALIDATION_QUERY
          : context === "params"
            ? ErrorCodes.VALIDATION_PARAMS
            : context === "headers"
              ? ErrorCodes.VALIDATION_HEADERS
              : ErrorCodes.VALIDATION_BODY;

      request.log.warn(
        { ...logContext, validation: error.validation, validationContext: context ?? "body" },
        "Fastify validation error",
      );

      return await reply.code(entry.status).send(
        buildErrorResponse(entry.code, error.message, { validation: error.validation }, requestId)
      );
    }

    // SyntaxError (malformed JSON)
    if (error instanceof SyntaxError && "body" in error) {
      request.log.warn({ ...logContext }, "Malformed JSON in request body");

      return await reply.code(400).send(
        buildErrorResponse("HAF-2001", "Malformed JSON in request body", undefined, requestId)
      );
    }

    // An external dependency we called could not be reached.
    //
    // Detected from the socket-level error code that `fetch` (undici) attaches,
    // walked through the `cause` chain because it is nested under a generic
    // "fetch failed" wrapper. This is deliberately not inferred from the error
    // message: prose changes, and `ECONNREFUSED` does not.
    //
    // Model-provider failures are already handled above by `ModelProviderError`,
    // and platform delivery by `ChannelDeliveryError`, so what reaches here is
    // the remaining outbound surface -- repository providers, MCP servers,
    // search backends. A 502 says "upstream, not us", which is actionable in a
    // way that an undifferentiated 500 is not.
    const dependencyCode = dependencyFailureCode(error);
    if (dependencyCode) {
      request.log.error({ ...logContext, dependencyCode, error: error.message }, "External dependency failure");
      const entry = ErrorCodes.SYSTEM_DEPENDENCY_FAILED;
      return await reply.code(entry.status).send(
        buildErrorResponse(entry.code, entry.message, { dependencyCode }, requestId),
      );
    }

    // Timeout
    if (error.message?.includes("timeout") || error.code === "ETIMEDOUT") {
      request.log.error({ ...logContext, error: error.message }, "Request timeout");

      return await reply.code(504).send(
        buildErrorResponse("HAF-8003", "Request timeout", undefined, requestId)
      );
    }

    // Unknown/unexpected error
    request.log.error({
      ...logContext,
      error: error.message,
      stack: error.stack,
      name: error.name,
    }, "Unhandled error");

    // Don't leak internal details in production
    const isDev = process.env.NODE_ENV !== "production";
    return await reply.code(500).send(
      buildErrorResponse(
        "HAF-8001",
        isDev ? error.message : "Internal server error",
        isDev ? { stack: error.stack } : undefined,
        requestId
      )
    );
  });

  // 404 handler
  app.setNotFoundHandler(async (request, reply) => {
    return await reply.code(404).send(
      buildErrorResponse(
        "HAF-7001",
        `Route ${request.method} ${request.url} not found`,
        { method: request.method, url: request.url },
        request.id
      )
    );
  });
}
