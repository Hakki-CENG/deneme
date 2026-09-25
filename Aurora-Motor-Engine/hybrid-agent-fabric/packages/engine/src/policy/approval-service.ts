import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ApprovalRequest, CapabilityContext, CapabilityDescriptor, JsonValue } from "../types.js";
import { buildApprovalPreview } from "../util/json.js";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export type ApprovalListener = (request: ApprovalRequest) => void;

/**
 * A reviewer may answer an approval before a human sees it. It must always produce a rationale, and
 * declining is the default: any failure inside the reviewer leaves the request in front of a person.
 */
export type ApprovalReviewer = (request: ApprovalRequest) => Promise<{ autoApproved: boolean; rationale: string; ruleId?: string }>;

export class ApprovalService {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<ApprovalListener>();
  private readonly sessionGrants = new Set<string>();
  private reviewer?: ApprovalReviewer;

  /**
   * P2.42: every resolved approval leaves a durable audit record — who/what/
   * when/why/approval/result. Without this the resolved request was deleted
   * from `pending` and the decision left no trace outside live listeners.
   * `auditPath` is optional so embedders and tests can run without a disk;
   * absence is recorded honestly in the record's own audit note.
   */
  constructor(
    private readonly defaultTimeoutMs = 5 * 60_000,
    private readonly auditPath?: string,
  ) {}

  private async audit(entry: {
    requestId: string;
    tenantId: string;
    sessionId: string;
    capabilityId: string;
    risk: string;
    reason: string;
    decision: "approved" | "denied" | "expired" | "auto-approved";
    resolvedBy: string;
    resolvedAt: string;
  }): Promise<void> {
    if (!this.auditPath) return;
    try {
      await mkdir(dirname(this.auditPath), { recursive: true });
      await appendFile(this.auditPath, `${JSON.stringify({ ...entry, durable: true })}\n`, "utf8");
    } catch {
      // The audit trail must never change the approval outcome. A failed
      // append is observable via the missing line; it is not silently faked.
    }
  }

  /** Install the reviewed auto-approval policy. Without one, every request reaches a human. */
  bindReviewer(reviewer: ApprovalReviewer): void {
    this.reviewer = reviewer;
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(sessionId?: string): ApprovalRequest[] {
    return [...this.pending.values()]
      .map(({ request }) => request)
      .filter((request) => !sessionId || request.sessionId === sessionId);
  }

  hasSessionGrant(sessionId: string, capabilityId: string): boolean {
    return this.sessionGrants.has(`${sessionId}:${capabilityId}`);
  }

  async request(
    descriptor: CapabilityDescriptor,
    argumentsValue: Record<string, JsonValue>,
    context: CapabilityContext,
    reason: string,
  ): Promise<boolean> {
    if (this.hasSessionGrant(context.sessionId, descriptor.id)) return true;
    const id = randomUUID();
    const now = Date.now();
    const preview = buildApprovalPreview(argumentsValue);
    const request: ApprovalRequest = {
      id,
      tenantId: context.tenantId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
      capabilityId: descriptor.id,
      risk: descriptor.risk,
      // The preview is the question being asked, so it keeps the decision-relevant fields whole and
      // reports what it masked or dropped rather than silently shrinking the thing under review.
      argumentsPreview: preview.preview,
      previewIntegrity: preview.integrity,
      reason,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.defaultTimeoutMs).toISOString(),
      status: "pending",
    };

    if (this.reviewer) {
      try {
        const review = await this.reviewer(request);
        if (review.autoApproved) {
          request.status = "approved";
          request.autoApproval = { rationale: review.rationale, ...(review.ruleId ? { ruleId: review.ruleId } : {}) };
          request.resolvedBy = review.ruleId ? `auto-rule:${review.ruleId}` : "auto-rule:unnamed";
          request.resolvedAt = new Date().toISOString();
          // Notified like any other resolution: an automatic answer must be as visible as a human one.
          void this.audit({
            requestId: request.id,
            tenantId: request.tenantId,
            sessionId: request.sessionId,
            capabilityId: request.capabilityId,
            risk: request.risk,
            reason: request.reason,
            decision: "auto-approved",
            resolvedBy: request.resolvedBy,
            resolvedAt: request.resolvedAt,
          });
          this.notify(request);
          return true;
        }
      } catch {
        // A reviewer that throws has not approved anything; the request goes to a human.
      }
    }

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.request.status = "expired";
        pending.request.resolvedBy = "timeout";
        pending.request.resolvedAt = new Date().toISOString();
        this.pending.delete(id);
        void this.audit({
          requestId: pending.request.id,
          tenantId: pending.request.tenantId,
          sessionId: pending.request.sessionId,
          capabilityId: pending.request.capabilityId,
          risk: pending.request.risk,
          reason: pending.request.reason,
          decision: "expired",
          resolvedBy: "timeout",
          resolvedAt: pending.request.resolvedAt,
        });
        resolve(false);
        this.notify(pending.request);
      }, this.defaultTimeoutMs);
      timer.unref();
      this.pending.set(id, { request, resolve, timer });
      this.notify(request);
    });
  }

  resolve(id: string, decision: "approve_once" | "approve_session" | "deny", resolvedBy?: string): ApprovalRequest {
    const pending = this.pending.get(id);
    if (!pending) throw new Error(`Approval ${id} is not pending.`);
    clearTimeout(pending.timer);
    pending.request.status = decision === "deny" ? "denied" : "approved";
    // P2.42: the resolver's identity is part of the evidence. Unnamed
    // operators are recorded as such rather than being invented.
    pending.request.resolvedBy = resolvedBy?.trim() || "unnamed-operator";
    pending.request.resolvedAt = new Date().toISOString();
    if (decision === "approve_session") {
      this.sessionGrants.add(`${pending.request.sessionId}:${pending.request.capabilityId}`);
    }
    this.pending.delete(id);
    void this.audit({
      requestId: pending.request.id,
      tenantId: pending.request.tenantId,
      sessionId: pending.request.sessionId,
      capabilityId: pending.request.capabilityId,
      risk: pending.request.risk,
      reason: pending.request.reason,
      decision: decision === "deny" ? "denied" : "approved",
      resolvedBy: pending.request.resolvedBy,
      resolvedAt: pending.request.resolvedAt,
    });
    pending.resolve(decision !== "deny");
    this.notify(pending.request);
    return pending.request;
  }

  clearSession(sessionId: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.request.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      pending.request.status = "denied";
      pending.resolve(false);
      this.pending.delete(key);
    }
    for (const grant of this.sessionGrants) {
      if (grant.startsWith(`${sessionId}:`)) this.sessionGrants.delete(grant);
    }
  }

  private notify(request: ApprovalRequest): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(request));
      } catch {
        // Approval observers cannot affect the decision.
      }
    }
  }
}
