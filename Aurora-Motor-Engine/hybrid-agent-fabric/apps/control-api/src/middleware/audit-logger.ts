/**
 * Audit Logger Middleware
 * Structured audit logging for all API calls.
 * Captures who did what, when, and from where.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export interface AuditEntry {
  timestamp: string;
  requestId: string;
  method: string;
  url: string;
  statusCode: number;
  durationMs: number;
  identity?: {
    type: string;
    userId?: string;
    tenantId?: string;
  };
  client: {
    ip: string;
    userAgent?: string;
  };
  request: {
    bodySize?: number;
    querySize?: number;
    contentType?: string;
  };
  response: {
    bodySize?: number;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

export interface AuditLoggerConfig {
  /** Path to audit log file */
  logFile?: string;
  /** Enable console output */
  console?: boolean;
  /** Skip logging for certain paths */
  skipPaths?: RegExp[];
  /** Skip logging for certain methods */
  skipMethods?: string[];
  /** Log request bodies (careful with sensitive data) */
  logBodies?: boolean;
  /** Max body size to log (bytes) */
  maxBodySize?: number;
  /** Batch writes for performance */
  batchWrites?: boolean;
  /** Batch interval in ms */
  batchInterval?: number;
}

const DEFAULT_CONFIG: AuditLoggerConfig = {
  console: process.env.NODE_ENV !== "production",
  skipPaths: [/^\/health$/, /^\/metrics$/, /^\/canvas/],
  skipMethods: ["OPTIONS"],
  logBodies: false,
  maxBodySize: 1024,
  batchWrites: true,
  batchInterval: 5000,
};

class AuditWriter {
  private buffer: AuditEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private logPath: string;
  private console: boolean;
  private batchWrites: boolean;

  constructor(config: AuditLoggerConfig) {
    this.logPath = config.logFile ?? resolve(process.env.HAF_HOME ?? "./var", "logs", "audit.jsonl");
    this.console = config.console ?? false;
    this.batchWrites = config.batchWrites ?? true;

    if (this.batchWrites && config.batchInterval) {
      this.flushTimer = setInterval(() => this.flush(), config.batchInterval);
    }
  }

  async write(entry: AuditEntry): Promise<void> {
    if (this.batchWrites) {
      this.buffer.push(entry);
      if (this.buffer.length >= 100) await this.flush();
    } else {
      await this.writeToFile(entry);
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const entries = [...this.buffer];
    this.buffer = [];

    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    try {
      await mkdir(dirname(this.logPath), { recursive: true });
      await appendFile(this.logPath, lines, "utf-8");
    } catch (err) {
      // Fallback to console if file write fails
      if (this.console) {
        for (const entry of entries) {
          console.log("[AUDIT]", JSON.stringify(entry));
        }
      }
    }
  }

  private async writeToFile(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    try {
      await mkdir(dirname(this.logPath), { recursive: true });
      await appendFile(this.logPath, line, "utf-8");
    } catch {
      if (this.console) console.log("[AUDIT]", line);
    }
  }

  destroy(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush().catch(() => {});
  }
}

let auditWriter: AuditWriter | null = null;

export function getAuditWriter(): AuditWriter | null {
  return auditWriter;
}

export async function registerAuditLogger(app: FastifyInstance, config: AuditLoggerConfig = {}): Promise<void> {
  const merged = { ...DEFAULT_CONFIG, ...config };
  auditWriter = new AuditWriter(merged);

  // Track request start time
  app.addHook("onRequest", async (request) => {
    (request as any).__auditStart = Date.now();
    (request as any).__auditId = request.id;
  });

  // Log on response
  app.addHook("onResponse", async (request, reply) => {
    // Skip configured paths
    if (merged.skipPaths?.some((re) => re.test(request.url))) return;
    if (merged.skipMethods?.includes(request.method)) return;

    const startMs = (request as any).__auditStart as number;
    const durationMs = Date.now() - (startMs || Date.now());

    const identity = (request as any).__identity as { type?: string; userId?: string; tenantId?: string } | undefined;

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      requestId: request.id,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs,
      ...(identity ? {
        identity: {
          type: identity.type ?? "unknown",
          ...(identity.userId ? { userId: identity.userId } : {}),
          ...(identity.tenantId ? { tenantId: identity.tenantId } : {}),
        },
      } : {}),
      client: {
        ip: request.ip || "unknown",
        ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      },
      request: {
        ...(request.headers["content-type"] ? { contentType: request.headers["content-type"] } : {}),
      },
      response: {},
    };

    await auditWriter!.write(entry);

    if (merged.console) {
      const level = reply.statusCode >= 500 ? "ERROR" : reply.statusCode >= 400 ? "WARN" : "INFO";
      console.log(`[AUDIT] ${level} ${request.method} ${request.url} ${reply.statusCode} ${durationMs}ms`);
    }
  });

  // Flush on shutdown
  app.addHook("onClose", async () => {
    auditWriter?.destroy();
  });
}
