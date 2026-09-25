import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SecuritySystemPipeline } from "../security/security-system.js";
import { defineCapability } from "./schema.js";

/**
 * P2.42 — security auditability. Every privileged action leaves evidence:
 * approval resolutions (who/what/when/why/decision) and security events
 * (injection detections, kill switch triggers). This reads the durable audit
 * trail and the live in-memory event log, and says which is which — a record
 * that exists only in memory is reported as in-memory, not as durable.
 */
export function securityAuditCapabilities(
  security: SecuritySystemPipeline,
  deps: { auditDir?: () => string } = {},
) {
  return [
    defineCapability(
      {
        id: "security.audit.query",
        version: "1.0.0",
        description:
          "Query the security audit trail: resolved approvals (who/what/when/why/decision) and security events (injection detections, kill switches), with the storage basis of each record stated (durable file or in-memory).",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ limit: z.number().int().min(1).max(500).default(50) }),
      async ({ limit }) => {
        const events = security.killSwitchManager
          .getSecurityEvents()
          .slice(-limit)
          .map((event) => ({ kind: "security-event" as const, basis: "in-memory" as const, record: event }));

        let approvals: Array<{ kind: "approval"; basis: "durable"; record: unknown }> = [];
        const dir = deps.auditDir?.();
        if (dir) {
          try {
            const lines = (await readFile(join(dir, "approvals.jsonl"), "utf8")).split("\n").filter(Boolean);
            approvals = lines.slice(-limit).map((line) => {
              const record = JSON.parse(line) as { resolvedAt?: string };
              return { kind: "approval" as const, basis: "durable" as const, record, ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}) };
            });
          } catch {
            // No durable approval trail at this path yet — reported as absent,
            // not fabricated.
          }
        }

        return {
          events,
          approvals,
          durableApprovalTrail: approvals.length > 0,
          auditDir: dir,
        };
      },
    ),
  ];
}
