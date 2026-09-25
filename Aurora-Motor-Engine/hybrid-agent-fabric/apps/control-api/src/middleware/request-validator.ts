/**
 * Request Validation Middleware
 * Centralized Zod validation to eliminate repeated parse calls.
 * Provides preHandler hooks for body, query, and params validation.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z, ZodSchema, ZodError } from "zod";

export interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
  headers?: ZodSchema;
}

/**
 * Create a preHandler hook that validates request parts against Zod schemas.
 * Parsed values are attached to request for downstream handlers.
 */
export function validate(schemas: ValidationSchemas) {
  return async function validationHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const errors: Array<{ location: string; field: string; message: string }> = [];

    if (schemas.params) {
      try {
        (request as any).params = schemas.params.parse(request.params);
      } catch (err) {
        if (err instanceof ZodError) {
          errors.push(...err.errors.map((e) => ({
            location: "params",
            field: e.path.join("."),
            message: e.message,
          })));
        }
      }
    }

    if (schemas.query) {
      try {
        (request as any).query = schemas.query.parse(request.query);
      } catch (err) {
        if (err instanceof ZodError) {
          errors.push(...err.errors.map((e) => ({
            location: "query",
            field: e.path.join("."),
            message: e.message,
          })));
        }
      }
    }

    if (schemas.body) {
      try {
        (request as any).body = schemas.body.parse(request.body);
      } catch (err) {
        if (err instanceof ZodError) {
          errors.push(...err.errors.map((e) => ({
            location: "body",
            field: e.path.join("."),
            message: e.message,
          })));
        }
      }
    }

    if (schemas.headers) {
      try {
        (request as any).headers = schemas.headers.parse(request.headers);
      } catch (err) {
        if (err instanceof ZodError) {
          errors.push(...err.errors.map((e) => ({
            location: "headers",
            field: e.path.join("."),
            message: e.message,
          })));
        }
      }
    }

    if (errors.length > 0) {
      await reply.code(400).send({
        error: {
          code: "HAF-2001",
          message: "Request validation failed",
          details: { fields: errors },
          requestId: request.id,
          timestamp: new Date().toISOString(),
        },
      });
    }
  };
}

/**
 * Helper: validate and parse body inline
 */
export function parseBody<T>(request: FastifyRequest, schema: ZodSchema<T>): T {
  return schema.parse(request.body);
}

/**
 * Helper: validate and parse query inline
 */
export function parseQuery<T>(request: FastifyRequest, schema: ZodSchema<T>): T {
  return schema.parse(request.query);
}

/**
 * Helper: validate and parse params inline
 */
export function parseParams<T>(request: FastifyRequest, schema: ZodSchema<T>): T {
  return schema.parse(request.params);
}

/**
 * Common validation schemas used across routes
 */
export const CommonSchemas = {
  pagination: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.string().optional(),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  }),

  tenantId: z.object({
    tenantId: z.string().default("local"),
  }),

  idParam: z.object({
    id: z.string().min(1),
  }),

  dateRange: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
} as const;
