/**
 * Integration Verification Loop — Aurora Cognitive Runtime
 *
 * Self-improvement → verification → rollback.
 * Immutable core protection.
 */

import { randomUUID } from "node:crypto";

/**
 * Verification result.
 */
export interface VerificationResult {
  id: string;
  targetId: string;
  targetType: "prompt" | "code" | "system";
  passed: boolean;
  checks: VerificationCheck[];
  score: number; // 0-1
  timestamp: string;
}

/**
 * Verification check.
 */
export interface VerificationCheck {
  name: string;
  passed: boolean;
  message: string;
  severity: "info" | "warning" | "error" | "critical";
}

/**
 * Rollback point.
 */
export interface RollbackPoint {
  id: string;
  targetId: string;
  targetType: "prompt" | "code" | "system";
  state: unknown;
  reason: string;
  createdAt: string;
  used: boolean;
  usedAt?: string;
}

/**
 * Integration test.
 */
export interface IntegrationTest {
  id: string;
  name: string;
  description: string;
  test: () => Promise<boolean>;
  timeout: number;
  retries: number;
}

/**
 * Verification Manager
 * 
 * Self-improvement → verification → rollback.
 */
export class VerificationManager {
  private readonly results = new Map<string, VerificationResult>();
  private readonly rollbackPoints = new Map<string, RollbackPoint>();

  /**
   * Verification çalıştır.
   */
  async verify(params: {
    targetId: string;
    targetType: "prompt" | "code" | "system";
    checks: Array<{
      name: string;
      check: () => Promise<boolean>;
      severity: VerificationCheck["severity"];
    }>;
  }): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];
    let passed = true;
    let score = 0;

    for (const check of params.checks) {
      try {
        const result = await check.check();
        checks.push({
          name: check.name,
          passed: result,
          message: result ? "Check passed" : "Check failed",
          severity: check.severity,
        });
        if (!result) passed = false;
        if (result) score += 1;
      } catch (error) {
        checks.push({
          name: check.name,
          passed: false,
          message: `Check error: ${error}`,
          severity: "critical",
        });
        passed = false;
      }
    }

    score = checks.length > 0 ? score / checks.length : 0;

    const result: VerificationResult = {
      id: randomUUID(),
      targetId: params.targetId,
      targetType: params.targetType,
      passed,
      checks,
      score,
      timestamp: new Date().toISOString(),
    };

    this.results.set(result.id, result);
    return result;
  }

  /**
   * Rollback point oluştur.
   */
  createRollbackPoint(params: {
    targetId: string;
    targetType: "prompt" | "code" | "system";
    state: unknown;
    reason: string;
  }): RollbackPoint {
    const id = randomUUID();
    const point: RollbackPoint = {
      id,
      targetId: params.targetId,
      targetType: params.targetType,
      state: params.state,
      reason: params.reason,
      createdAt: new Date().toISOString(),
      used: false,
    };
    this.rollbackPoints.set(id, point);
    return point;
  }

  /**
   * Rollback yap.
   */
  rollback(pointId: string): { success: boolean; state: unknown } | null {
    const point = this.rollbackPoints.get(pointId);
    if (!point) return null;

    point.used = true;
    point.usedAt = new Date().toISOString();

    return { success: true, state: point.state };
  }

  /**
   * Rollback point'leri al.
   */
  getRollbackPoints(targetId?: string): RollbackPoint[] {
    const points = [...this.rollbackPoints.values()];
    if (targetId) {
      return points.filter(p => p.targetId === targetId);
    }
    return points;
  }

  /**
   * Verification sonuçlarını al.
   */
  getResults(): VerificationResult[] {
    return [...this.results.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalVerifications: number;
    passedVerifications: number;
    failedVerifications: number;
    totalRollbackPoints: number;
    usedRollbackPoints: number;
    avgScore: number;
  } {
    const results = [...this.results.values()];
    const points = [...this.rollbackPoints.values()];

    return {
      totalVerifications: results.length,
      passedVerifications: results.filter(r => r.passed).length,
      failedVerifications: results.filter(r => !r.passed).length,
      totalRollbackPoints: points.length,
      usedRollbackPoints: points.filter(p => p.used).length,
      avgScore: results.length > 0
        ? results.reduce((sum, r) => sum + r.score, 0) / results.length
        : 0,
    };
  }
}

/**
 * Integration Test Runner
 * 
 * Integration tests çalıştırır.
 */
export class IntegrationTestRunner {
  private readonly tests = new Map<string, IntegrationTest>();
  private readonly results = new Map<string, { testId: string; passed: boolean; duration: number; timestamp: string }>();

  /**
   * Test ekle.
   */
  addTest(params: {
    name: string;
    description: string;
    test: () => Promise<boolean>;
    timeout?: number;
    retries?: number;
  }): IntegrationTest {
    const id = randomUUID();
    const test: IntegrationTest = {
      id,
      name: params.name,
      description: params.description,
      test: params.test,
      timeout: params.timeout ?? 5000,
      retries: params.retries ?? 1,
    };
    this.tests.set(id, test);
    return test;
  }

  /**
   * Test çalıştır.
   */
  async runTest(testId: string): Promise<{ passed: boolean; duration: number }> {
    const test = this.tests.get(testId);
    if (!test) {
      throw new Error(`Test not found: ${testId}`);
    }

    const startTime = Date.now();
    let passed = false;

    for (let attempt = 0; attempt < test.retries; attempt++) {
      try {
        passed = await Promise.race([
          test.test(),
          new Promise<boolean>((_, reject) =>
            setTimeout(() => reject(new Error("Test timeout")), test.timeout)
          ),
        ]);
        if (passed) break;
      } catch (error) {
        passed = false;
      }
    }

    const duration = Date.now() - startTime;

    this.results.set(testId, {
      testId,
      passed,
      duration,
      timestamp: new Date().toISOString(),
    });

    return { passed, duration };
  }

  /**
   * Tüm test'leri çalıştır.
   */
  async runAllTests(): Promise<{
    total: number;
    passed: number;
    failed: number;
    results: Array<{ testId: string; name: string; passed: boolean; duration: number }>;
  }> {
    const results: Array<{ testId: string; name: string; passed: boolean; duration: number }> = [];

    for (const test of this.tests.values()) {
      const { passed, duration } = await this.runTest(test.id);
      results.push({
        testId: test.id,
        name: test.name,
        passed,
        duration,
      });
    }

    return {
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      results,
    };
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalTests: number;
    totalRuns: number;
    passedRuns: number;
    failedRuns: number;
    avgDuration: number;
  } {
    const results = [...this.results.values()];
    return {
      totalTests: this.tests.size,
      totalRuns: results.length,
      passedRuns: results.filter(r => r.passed).length,
      failedRuns: results.filter(r => !r.passed).length,
      avgDuration: results.length > 0
        ? results.reduce((sum, r) => sum + r.duration, 0) / results.length
        : 0,
    };
  }
}

/**
 * Immutable Core Guardian
 * 
 * Immutable core protection.
 */
export class ImmutableCoreGuardian {
  private readonly protectedComponents = new Map<string, {
    name: string;
    path: string;
    hash: string;
    immutable: boolean;
    lastVerified: string;
  }>();

  /**
   * Protected component ekle.
   */
  addProtectedComponent(params: {
    name: string;
    path: string;
    hash: string;
    immutable: boolean;
  }): void {
    this.protectedComponents.set(params.name, {
      ...params,
      lastVerified: new Date().toISOString(),
    });
  }

  /**
   * Component'in immutable olup olmadığını kontrol et.
   */
  isImmutable(name: string): boolean {
    const component = this.protectedComponents.get(name);
    return component?.immutable ?? false;
  }

  /**
   * Component hash'ini doğrula.
   */
  verifyHash(name: string, currentHash: string): boolean {
    const component = this.protectedComponents.get(name);
    if (!component) return false;

    return component.hash === currentHash;
  }

  /**
   * Component'i güncelle (sadece immutable olmayan).
   */
  updateComponent(name: string, newHash: string): boolean {
    const component = this.protectedComponents.get(name);
    if (!component || component.immutable) return false;

    component.hash = newHash;
    component.lastVerified = new Date().toISOString();
    return true;
  }

  /**
   * Protected component'leri al.
   */
  getProtectedComponents(): Array<{
    name: string;
    path: string;
    hash: string;
    immutable: boolean;
    lastVerified: string;
  }> {
    return [...this.protectedComponents.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalComponents: number;
    immutableComponents: number;
    mutableComponents: number;
  } {
    const components = [...this.protectedComponents.values()];
    return {
      totalComponents: components.length,
      immutableComponents: components.filter(c => c.immutable).length,
      mutableComponents: components.filter(c => !c.immutable).length,
    };
  }
}

/**
 * Integration Verification Pipeline
 * 
 * Self-improvement → verification → rollback pipeline.
 */
export class IntegrationVerificationPipeline {
  readonly verificationManager: VerificationManager;
  readonly testRunner: IntegrationTestRunner;
  readonly coreGuardian: ImmutableCoreGuardian;

  constructor() {
    this.verificationManager = new VerificationManager();
    this.testRunner = new IntegrationTestRunner();
    this.coreGuardian = new ImmutableCoreGuardian();
  }

  /**
   * Protected core'ları başlat.
   */
  initializeProtectedCores(): void {
    this.coreGuardian.addProtectedComponent({
      name: "engine-core",
      path: "packages/engine/src/engine.ts",
      hash: "immutable-hash-1",
      immutable: true,
    });

    this.coreGuardian.addProtectedComponent({
      name: "eval-core",
      path: "packages/eval/src/",
      hash: "immutable-hash-2",
      immutable: true,
    });

    this.coreGuardian.addProtectedComponent({
      name: "cognitive-loop",
      path: "packages/engine/src/aurora/unified-cognitive-loop.ts",
      hash: "immutable-hash-3",
      immutable: true,
    });
  }

  /**
   * Self-improvement → verification → rollback pipeline.
   */
  async runPipeline(params: {
    targetId: string;
    targetType: "prompt" | "code" | "system";
    improvement: unknown;
    verificationChecks: Array<{
      name: string;
      check: () => Promise<boolean>;
      severity: "info" | "warning" | "error" | "critical";
    }>;
  }): Promise<{
    verificationResult: VerificationResult;
    rollbackPoint: RollbackPoint;
    success: boolean;
  }> {
    // 1. Rollback point oluştur
    const rollbackPoint = this.verificationManager.createRollbackPoint({
      targetId: params.targetId,
      targetType: params.targetType,
      state: params.improvement,
      reason: "Before self-improvement verification",
    });

    // 2. Verification çalıştır
    const verificationResult = await this.verificationManager.verify({
      targetId: params.targetId,
      targetType: params.targetType,
      checks: params.verificationChecks,
    });

    // 3. Eğer verification başarısız ise rollback yap
    if (!verificationResult.passed) {
      this.verificationManager.rollback(rollbackPoint.id);
    }

    return {
      verificationResult,
      rollbackPoint,
      success: verificationResult.passed,
    };
  }

  /**
   * Pipeline istatistiklerini al.
   */
  getStats(): {
    verificationManager: ReturnType<VerificationManager["getStats"]>;
    testRunner: ReturnType<IntegrationTestRunner["getStats"]>;
    coreGuardian: ReturnType<ImmutableCoreGuardian["getStats"]>;
  } {
    return {
      verificationManager: this.verificationManager.getStats(),
      testRunner: this.testRunner.getStats(),
      coreGuardian: this.coreGuardian.getStats(),
    };
  }
}
