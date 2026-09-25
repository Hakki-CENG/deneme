import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { DomainExpertService } from "../src/domain-experts/domain-expert-service.js";

/**
 * This service is reachable over HTTP (`/v1/domain-experts/*`, registered from
 * main.ts) and answers questions about law, finance and health. It had no
 * tests at all, while `maturity.ts` recorded it as wired to the engine.
 *
 * The tests below are deliberately about honesty rather than features. The
 * service does not have real legal or medical knowledge and is not supposed
 * to: what matters is that it never dresses an absence of knowledge up as a
 * finding.
 */

function service(): DomainExpertService {
  return new DomainExpertService(mkdtempSync(join(tmpdir(), "domain-expert-")));
}

describe("DomainExpertService", () => {
  let svc: DomainExpertService;

  beforeEach(async () => {
    svc = service();
    await svc.init();
  });

  describe("compliance checks", () => {
    it("reports unknown, not compliant, when no requirements are loaded", async () => {
      // The bug this pins: `[].every(r => r.met)` is true, so an empty
      // requirement list scored 100 and returned "compliant". An HTTP caller
      // asking about legal compliance in an unloaded jurisdiction was told it
      // was fully compliant — the worst possible answer for a high-risk domain.
      const check = await svc.checkCompliance("local", "legal", "TR");

      expect(check.requirements).toHaveLength(0);
      expect(check.status).toBe("unknown");
      expect(check.score).toBe(0);
      expect(check.unknownReason).toMatch(/not a finding of compliance/i);
    });

    it("never claims compliance for any domain without requirements to check", async () => {
      // Stated as an invariant over the requirement list rather than over the
      // status, because the first phrasing was measured to be too weak: a
      // sabotage restoring `compliant`/100 satisfied its `else` branch. The
      // rule that actually matters is that a verdict needs evidence.
      for (const domain of ["legal", "finance", "health", "tax"] as const) {
        const check = await svc.checkCompliance("local", domain, "TR");

        if (check.requirements.length === 0) {
          expect(check.status).toBe("unknown");
          expect(check.score).toBe(0);
        } else {
          // With requirements loaded, a "compliant" verdict must mean every
          // one of them was actually met.
          if (check.status === "compliant") {
            expect(check.requirements.every((item) => item.met)).toBe(true);
          }
          expect(check.score).toBe(
            (check.requirements.filter((item) => item.met).length / check.requirements.length) * 100,
          );
        }
      }
    });

    it("records the check so an audit can see what was asked", async () => {
      await svc.checkCompliance("local", "finance", "EU");
      const again = await svc.checkCompliance("other-tenant", "finance", "EU");

      // Distinct ids: two questions, two records, not one overwritten.
      const first = await svc.checkCompliance("local", "finance", "EU");
      expect(first.id).not.toBe(again.id);
      expect(first.checkedAt).toBeTruthy();
    });
  });

  describe("consultations", () => {
    it("refuses a domain it has no active expert for", async () => {
      // Saying nothing is correct here. Answering a medical question with a
      // generic template would be worse than declining.
      await expect(svc.consult("local", "immigration", "Can I stay?")).rejects.toThrow(
        /No active expert/i,
      );
    });

    it("reports low confidence and demands professional review when it has no sources", async () => {
      const consultation = await svc.consult("local", "health", "Chest pain and shortness of breath");

      // It found nothing, so it must not sound confident.
      expect(consultation.response.sources).toHaveLength(0);
      expect(consultation.response.confidence).toBeLessThanOrEqual(0.2);
      expect(consultation.response.requiresProfessionalReview).toBe(true);
      expect(consultation.response.disclaimers.length).toBeGreaterThan(0);
      expect(consultation.response.riskAssessment.level).toMatch(/high|critical/);
    });

    it("keeps confidence bounded to what the sources justify", async () => {
      // Confidence is derived from sources; with none it must sit at the floor.
      // This catches a future change that hard-codes an optimistic number.
      const a = await svc.consult("local", "legal", "Is this contract valid?");
      const b = await svc.consult("local", "finance", "Should I buy this stock?");

      for (const consultation of [a, b]) {
        expect(consultation.response.confidence).toBeGreaterThan(0);
        expect(consultation.response.confidence).toBeLessThan(0.5);
      }
    });

    it("stores consultations per tenant", async () => {
      await svc.consult("tenant-a", "legal", "Question A");
      await svc.consult("tenant-b", "legal", "Question B");

      const forA = await svc.getConsultations("tenant-a");
      const forB = await svc.getConsultations("tenant-b");

      expect(forA).toHaveLength(1);
      expect(forB).toHaveLength(1);
      expect(forA[0]?.query).toBe("Question A");
      // Tenant isolation: one tenant must not read another's consultations.
      expect(forA.some((item) => item.query === "Question B")).toBe(false);
    });
  });

  describe("expert registry", () => {
    it("seeds experts that declare their own limits", async () => {
      const experts = await svc.getExperts();
      expect(experts.length).toBeGreaterThan(0);

      for (const expert of experts) {
        // A high-risk expert with no disclaimers and no stated limitations is
        // the thing this service must never ship.
        expect(expert.disclaimers.length).toBeGreaterThan(0);
        expect(expert.limitations.length).toBeGreaterThan(0);
        expect(["high", "very_high", "critical"]).toContain(expert.riskLevel);
      }
    });

    it("filters by domain", async () => {
      const legal = await svc.getExperts("legal");
      expect(legal.every((expert) => expert.domain === "legal")).toBe(true);
    });
  });
});
