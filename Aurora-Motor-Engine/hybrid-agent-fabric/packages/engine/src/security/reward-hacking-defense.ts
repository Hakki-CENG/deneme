/**
 * Reward Hacking Defense — Aurora Cognitive Runtime
 *
 * Protected evaluation/security layer.
 * Attack set testing.
 */

import { randomUUID } from "node:crypto";
import {
  buildDefenceChecks,
  detectorForCategory,
  type DefenceEvidence,
} from "./reward-hacking-detectors.js";

/**
 * Attack pattern.
 */
export interface AttackPattern {
  id: string;
  name: string;
  description: string;
  category: "reward_hacking" | "metric_gaming" | "evaluation_cheating" | "data_poisoning";
  severity: "low" | "medium" | "high" | "critical";
  detection: string;
  mitigation: string;
}

/**
 * Attack test result.
 */
export interface AttackTestResult {
  id: string;
  attackId: string;
  passed: boolean;
  detected: boolean;
  mitigated: boolean;
  score: number; // 0-1
  timestamp: string;
}

/**
 * Security audit.
 */
export interface SecurityAudit {
  id: string;
  targetId: string;
  targetType: "system" | "model" | "evaluation";
  findings: SecurityFinding[];
  riskLevel: "low" | "medium" | "high" | "critical";
  timestamp: string;
}

/**
 * Security finding.
 */
export interface SecurityFinding {
  id: string;
  category: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  recommendation: string;
}

/**
 * Protected Evaluation Layer
 * 
 * Protected evaluation/security layer.
 */
export class ProtectedEvaluationLayer {
  private readonly protectedMetrics = new Map<string, {
    name: string;
    protected: boolean;
    validation: (value: number) => boolean;
  }>();

  /**
   * Protected metric ekle.
   */
  addProtectedMetric(params: {
    name: string;
    protected: boolean;
    validation: (value: number) => boolean;
  }): void {
    this.protectedMetrics.set(params.name, params);
  }

  /**
   * Metric'in protected olup olmadığını kontrol et.
   */
  isProtected(metricName: string): boolean {
    return this.protectedMetrics.get(metricName)?.protected ?? false;
  }

  /**
   * Metric değerini doğrula.
   */
  validateMetric(metricName: string, value: number): boolean {
    const metric = this.protectedMetrics.get(metricName);
    if (!metric) return false;
    return metric.validation(value);
  }

  /**
   * Protected metric'leri al.
   */
  getProtectedMetrics(): Array<{
    name: string;
    protected: boolean;
  }> {
    return [...this.protectedMetrics.values()].map(m => ({
      name: m.name,
      protected: m.protected,
    }));
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalMetrics: number;
    protectedMetrics: number;
  } {
    const metrics = [...this.protectedMetrics.values()];
    return {
      totalMetrics: metrics.length,
      protectedMetrics: metrics.filter(m => m.protected).length,
    };
  }
}

/**
 * Attack Pattern Library
 * 
 * Attack set testing.
 */
export class AttackPatternLibrary {
  private readonly patterns = new Map<string, AttackPattern>();

  /**
   * Varsayılan attack pattern'leri ekle.
   */
  addDefaultPatterns(): void {
    const defaults: Omit<AttackPattern, "id">[] = [
      {
        name: "Reward Curve Manipulation",
        description: "Manipulating reward curves to maximize score without real improvement",
        category: "reward_hacking",
        severity: "high",
        detection: "Check for sudden reward spikes without corresponding capability improvement",
        mitigation: "Use multiple independent reward signals and cross-validate",
      },
      {
        name: "Metric Gaming",
        description: "Gaming specific metrics without improving underlying capability",
        category: "metric_gaming",
        severity: "high",
        detection: "Compare metric improvements with actual task performance",
        mitigation: "Use holistic evaluation with multiple metrics",
      },
      {
        name: "Evaluation Cheating",
        description: "Exploiting evaluation loopholes to get higher scores",
        category: "evaluation_cheating",
        severity: "critical",
        detection: "Monitor for unusual patterns in evaluation results",
        mitigation: "Randomize evaluation and use held-out test sets",
      },
      {
        name: "Data Poisoning",
        description: "Injecting malicious data to skew training or evaluation",
        category: "data_poisoning",
        severity: "critical",
        detection: "Statistical analysis of data distribution",
        mitigation: "Data validation and anomaly detection",
      },
    ];

    for (const pattern of defaults) {
      this.addPattern(pattern);
    }
  }

  /**
   * Attack pattern ekle.
   */
  addPattern(params: Omit<AttackPattern, "id">): AttackPattern {
    const id = randomUUID();
    const pattern: AttackPattern = {
      ...params,
      id,
    };
    this.patterns.set(id, pattern);
    return pattern;
  }

  /**
   * Pattern'leri al.
   */
  getPatterns(): AttackPattern[] {
    return [...this.patterns.values()];
  }

  /**
   * Kategoriye göre pattern'leri al.
   */
  getPatternsByCategory(category: AttackPattern["category"]): AttackPattern[] {
    return [...this.patterns.values()].filter(p => p.category === category);
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalPatterns: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
  } {
    const patterns = [...this.patterns.values()];
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};

    for (const pattern of patterns) {
      byCategory[pattern.category] = (byCategory[pattern.category] ?? 0) + 1;
      bySeverity[pattern.severity] = (bySeverity[pattern.severity] ?? 0) + 1;
    }

    return {
      totalPatterns: patterns.length,
      byCategory,
      bySeverity,
    };
  }
}

/**
 * Attack Tester
 * 
 * Attack set testing.
 */
export class AttackTester {
  private readonly results = new Map<string, AttackTestResult>();

  /**
   * Attack testi çalıştır.
   */
  async runAttackTest(params: {
    attackId: string;
    target: unknown;
    detection: () => Promise<boolean>;
    mitigation: () => Promise<boolean>;
  }): Promise<AttackTestResult> {
    const id = randomUUID();

    // Detection testi
    const detected = await params.detection();

    // Mitigation testi
    const mitigated = await params.mitigation();

    // Score hesapla
    let score = 0;
    if (detected) score += 0.5;
    if (mitigated) score += 0.5;

    const result: AttackTestResult = {
      id,
      attackId: params.attackId,
      passed: detected && mitigated,
      detected,
      mitigated,
      score,
      timestamp: new Date().toISOString(),
    };

    this.results.set(id, result);
    return result;
  }

  /**
   * Sonuçları al.
   */
  getResults(): AttackTestResult[] {
    return [...this.results.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalTests: number;
    passedTests: number;
    failedTests: number;
    avgScore: number;
  } {
    const results = [...this.results.values()];
    return {
      totalTests: results.length,
      passedTests: results.filter(r => r.passed).length,
      failedTests: results.filter(r => !r.passed).length,
      avgScore: results.length > 0
        ? results.reduce((sum, r) => sum + r.score, 0) / results.length
        : 0,
    };
  }
}

/**
 * Security Auditor
 * 
 * Security audit.
 */
export class SecurityAuditor {
  private readonly audits = new Map<string, SecurityAudit>();

  /**
   * Security audit çalıştır.
   */
  async runAudit(params: {
    targetId: string;
    targetType: "system" | "model" | "evaluation";
    checks: Array<{
      category: string;
      check: () => Promise<boolean>;
      description: string;
      severity: SecurityFinding["severity"];
      recommendation: string;
    }>;
  }): Promise<SecurityAudit> {
    const findings: SecurityFinding[] = [];
    let maxSeverity: SecurityFinding["severity"] = "low";

    for (const check of params.checks) {
      try {
        const passed = await check.check();
        if (!passed) {
          findings.push({
            id: randomUUID(),
            category: check.category,
            description: check.description,
            severity: check.severity,
            recommendation: check.recommendation,
          });

          // Max severity güncelle
          const severityOrder = { low: 1, medium: 2, high: 3, critical: 4 };
          if (severityOrder[check.severity] > severityOrder[maxSeverity]) {
            maxSeverity = check.severity;
          }
        }
      } catch (error) {
        findings.push({
          id: randomUUID(),
          category: check.category,
          description: `Check failed: ${error}`,
          severity: "critical",
          recommendation: "Investigate check failure",
        });
        maxSeverity = "critical";
      }
    }

    const audit: SecurityAudit = {
      id: randomUUID(),
      targetId: params.targetId,
      targetType: params.targetType,
      findings,
      riskLevel: maxSeverity,
      timestamp: new Date().toISOString(),
    };

    this.audits.set(audit.id, audit);
    return audit;
  }

  /**
   * Audit'leri al.
   */
  getAudits(): SecurityAudit[] {
    return [...this.audits.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalAudits: number;
    byRiskLevel: Record<string, number>;
    totalFindings: number;
  } {
    const audits = [...this.audits.values()];
    const byRiskLevel: Record<string, number> = {};
    let totalFindings = 0;

    for (const audit of audits) {
      byRiskLevel[audit.riskLevel] = (byRiskLevel[audit.riskLevel] ?? 0) + 1;
      totalFindings += audit.findings.length;
    }

    return {
      totalAudits: audits.length,
      byRiskLevel,
      totalFindings,
    };
  }
}

/**
 * Reward Hacking Defense Pipeline
 * 
 * Protected evaluation/security layer + attack set testing.
 */
export class RewardHackingDefensePipeline {
  readonly protectedEvaluation: ProtectedEvaluationLayer;
  readonly attackPatterns: AttackPatternLibrary;
  readonly attackTester: AttackTester;
  readonly securityAuditor: SecurityAuditor;

  constructor() {
    this.protectedEvaluation = new ProtectedEvaluationLayer();
    this.attackPatterns = new AttackPatternLibrary();
    this.attackTester = new AttackTester();
    this.securityAuditor = new SecurityAuditor();
  }

  /**
   * Pipeline'ı başlat.
   */
  initialize(): void {
    // Protected metrics ekle
    this.protectedEvaluation.addProtectedMetric({
      name: "accuracy",
      protected: true,
      validation: (value) => value >= 0 && value <= 1,
    });

    this.protectedEvaluation.addProtectedMetric({
      name: "f1_score",
      protected: true,
      validation: (value) => value >= 0 && value <= 1,
    });

    this.protectedEvaluation.addProtectedMetric({
      name: "reward",
      protected: true,
      validation: (value) => value >= 0 && value <= 1,
    });

    // Attack pattern'leri ekle
    this.attackPatterns.addDefaultPatterns();
  }

  /**
   * Full defense pipeline çalıştır.
   */
  async runDefensePipeline(params: {
    targetId: string;
    targetType: "system" | "model" | "evaluation";
    /**
     * Observed behaviour to run the detectors against.
     *
     * Omitting this yields a pipeline that reports "clean" simply because it
     * has nothing to inspect, so `evidenceSupplied` is returned alongside the
     * verdict: an audit with no evidence is not the same as a passing audit.
     */
    evidence?: DefenceEvidence | undefined;
  }): Promise<{
    securityAudit: SecurityAudit;
    attackTests: AttackTestResult[];
    overallRisk: "low" | "medium" | "high" | "critical";
    /** False when no behavioural evidence was provided to inspect. */
    evidenceSupplied: boolean;
  }> {
    const evidence: DefenceEvidence = params.evidence ?? {};
    const evidenceSupplied = Boolean(
      evidence.scoreHistory?.length ||
        evidence.evaluations?.length ||
        evidence.dataSamples?.length ||
        (evidence.metrics && Object.keys(evidence.metrics).length > 0),
    );

    // 1. Security audit — executable checks, not stubs. Each one can fail.
    const securityAudit = await this.securityAuditor.runAudit({
      targetId: params.targetId,
      targetType: params.targetType,
      checks: buildDefenceChecks(evidence),
    });

    // 2. Attack tests, driven by the same real detectors.
    const attackTests: AttackTestResult[] = [];
    const patterns = this.attackPatterns.getPatterns();

    for (const pattern of patterns) {
      const verdict = detectorForCategory(pattern.category, evidence);
      const result = await this.attackTester.runAttackTest({
        attackId: pattern.id,
        target: params.targetId,
        // `detected` means the defence spotted the attack signature. A clean
        // verdict means there was nothing to spot.
        detection: async () => !verdict.clean,
        // Mitigation is only meaningful once something was detected; claiming
        // a successful mitigation of a non-existent attack is how the old stub
        // produced its fake perfect score.
        mitigation: async () => verdict.clean,
      });
      attackTests.push(result);
    }

    // 3. Overall risk
    const overallRisk = securityAudit.riskLevel;

    return {
      securityAudit,
      attackTests,
      overallRisk,
      evidenceSupplied,
    };
  }

  /**
   * Pipeline istatistiklerini al.
   */
  getStats(): {
    protectedEvaluation: ReturnType<ProtectedEvaluationLayer["getStats"]>;
    attackPatterns: ReturnType<AttackPatternLibrary["getStats"]>;
    attackTester: ReturnType<AttackTester["getStats"]>;
    securityAuditor: ReturnType<SecurityAuditor["getStats"]>;
  } {
    return {
      protectedEvaluation: this.protectedEvaluation.getStats(),
      attackPatterns: this.attackPatterns.getStats(),
      attackTester: this.attackTester.getStats(),
      securityAuditor: this.securityAuditor.getStats(),
    };
  }
}
