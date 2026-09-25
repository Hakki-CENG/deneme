/**
 * Per-service error typing for the Aurora surfaces.
 *
 * The `AURORA_*_ERROR` codes were registered in the error-code registry and
 * nothing produced them: the services behind these routes throw plain `Error`s
 * with no per-service typing, so a cognitive-orchestrator failure and an
 * initiative-engine failure reached the client as the same undifferentiated 500.
 *
 * Applied through Fastify's `onRoute` hook rather than by editing each of the
 * ~280 route declarations. Every route registered after this call — inline and
 * from the route modules — is covered, and the URL→service mapping lives in one
 * readable table instead of being implied by 280 edit sites.
 *
 * Two errors pass straight through:
 * - a `ZodError` is a 400 about the caller's request, not a 500 about the
 *   service, and rewriting it here would turn every malformed body into a
 *   server fault;
 * - an `AppError` is already typed by whoever threw it and knows more about
 *   itself than this table does.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError, type ErrorCodeKey } from "../middleware/error-handler.js";

export const AURORA_SERVICE_CODES: ReadonlyArray<{ pattern: RegExp; code: ErrorCodeKey }> = [
  { pattern: /^\/v1\/initiative(?:\/|$)/, code: "AURORA_INITIATIVE_ERROR" },
  { pattern: /^\/v1\/evolution(?:\/|$)/, code: "AURORA_EVOLUTION_ERROR" },
  { pattern: /^\/v1\/cognitive(?:\/|$)/, code: "AURORA_COGNITIVE_ERROR" },
];

/**
 * There is no `AURORA_THOUGHT_ERROR` entry on purpose. The code used to be
 * registered, and nothing could ever return it: no HTTP surface calls thought
 * processing (`engine.thoughtCore` and `engine.backgroundThinking` are driven by
 * the engine lifecycle, not by a route). It was removed from the registry rather
 * than mapped here, because a documented response the API cannot send is worse
 * than no code at all.
 */
export function registerAuroraServiceErrorTyping(app: FastifyInstance): void {
  app.addHook("onRoute", (routeOptions) => {
    const entry = AURORA_SERVICE_CODES.find((candidate) => candidate.pattern.test(routeOptions.url ?? ""));
    if (!entry) return;
    const handler = routeOptions.handler as (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    routeOptions.handler = async function auroraServiceHandler(
      this: unknown,
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<unknown> {
      try {
        return await handler.call(this, request, reply);
      } catch (error) {
        if (error instanceof ZodError || error instanceof AppError) throw error;
        throw new AppError(
          entry.code,
          {
            route: routeOptions.url,
            reason: error instanceof Error ? error.message : String(error),
          },
          error instanceof Error ? error : undefined,
        );
      }
    } as typeof routeOptions.handler;
  });
}
