/**
 * Route Registration Pattern
 * Her route modülü bu interface'i implement eder.
 */
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { HybridAgentEngine } from "@haf/engine";

export interface RouteContext {
  app: FastifyInstance;
  engine: HybridAgentEngine;
  z: typeof z;
}
