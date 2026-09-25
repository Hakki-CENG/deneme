/**
 * Gap Engine — Aurora Cognitive Runtime
 *
 * Failure classification (knowledge/tool/skill/interface/permission/...).
 * Deterministic → structural → LLM analysis.
 */

import { randomUUID } from "node:crypto";

/**
 * Failure category.
 */
export type FailureCategory =
  | "knowledge"     // Bilgi eksikliği
  | "tool"          // Tool hatası
  | "skill"         // Skill eksikliği
  | "interface"     // Interface uyumsuzluğu
  | "permission"    // İzin hatası
  | "resource"      // Kaynak hatası
  | "network"       // Ağ hatası
  | "timeout"       // Zaman aşımı
  | "validation"    // Doğrulama hatası
  | "logic"         // Mantık hatası
  | "unknown";      // Bilinmeyen hata

/**
 * Failure severity.
 */
export type FailureSeverity = "low" | "medium" | "high" | "critical";

/**
 * Failure analysis level.
 */
export type AnalysisLevel = "deterministic" | "structural" | "llm";

/**
 * Failure record.
 */
export interface FailureRecord {
  id: string;
  category: FailureCategory;
  severity: FailureSeverity;
  description: string;
  context: Record<string, unknown>;
  stackTrace?: string | undefined;
  timestamp: string;
  resolved: boolean;
  resolution?: string | undefined;
  analysis?: FailureAnalysis | undefined;
}

/**
 * Failure analysis.
 */
export interface FailureAnalysis {
  id: string;
  failureId: string;
  level: AnalysisLevel;
  rootCause: string;
  contributingFactors: string[];
  suggestedFixes: string[];
  confidence: number;
  analyzedAt: string;
}

/**
 * Gap analysis result.
 */
export interface GapAnalysisResult {
  id: string;
  failures: FailureRecord[];
  patterns: FailurePattern[];
  recommendations: GapRecommendation[];
  analyzedAt: string;
}

/**
 * Failure pattern.
 */
export interface FailurePattern {
  id: string;
  category: FailureCategory;
  description: string;
  frequency: number;
  examples: string[];
  firstSeen: string;
  lastSeen: string;
}

/**
 * Gap recommendation.
 */
export interface GapRecommendation {
  id: string;
  type: "fix" | "workaround" | "prevent" | "mitigate";
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  estimatedEffort: "low" | "medium" | "high";
  relatedFailures: string[];
}

/**
 * Deterministic Analyzer
 * 
 * Pattern matching ile hata analizi.
 */
export class DeterministicAnalyzer {
  private readonly patterns = new Map<string, {
    pattern: RegExp;
    category: FailureCategory;
    severity: FailureSeverity;
    description: string;
  }>();

  constructor() {
    this.registerDefaultPatterns();
  }

  /**
   * Default pattern'leri kaydet.
   */
  private registerDefaultPatterns(): void {
    // Tool errors
    this.registerPattern({
      pattern: /tool.*not.*found|unknown.*tool/i,
      category: "tool",
      severity: "high",
      description: "Tool not found error",
    });

    this.registerPattern({
      pattern: /tool.*failed|tool.*error/i,
      category: "tool",
      severity: "medium",
      description: "Tool execution failed",
    });

    // Permission errors
    this.registerPattern({
      pattern: /permission.*denied|access.*denied|forbidden/i,
      category: "permission",
      severity: "high",
      description: "Permission denied error",
    });

    // Network errors
    this.registerPattern({
      pattern: /network.*error|connection.*refused|timeout/i,
      category: "network",
      severity: "medium",
      description: "Network error",
    });

    // Validation errors
    this.registerPattern({
      pattern: /validation.*error|invalid.*input|schema.*error/i,
      category: "validation",
      severity: "medium",
      description: "Validation error",
    });

    // Knowledge errors
    this.registerPattern({
      pattern: /not.*found|does.*not.*exist|unknown/i,
      category: "knowledge",
      severity: "medium",
      description: "Knowledge not found",
    });

    // Resource errors
    this.registerPattern({
      pattern: /out.*of.*memory|resource.*exhausted|quota.*exceeded/i,
      category: "resource",
      severity: "critical",
      description: "Resource exhaustion",
    });

    // Timeout errors
    this.registerPattern({
      pattern: /timeout|timed.*out|deadline.*exceeded/i,
      category: "timeout",
      severity: "high",
      description: "Timeout error",
    });
  }

  /**
   * Pattern kaydet.
   */
  registerPattern(params: {
    pattern: RegExp;
    category: FailureCategory;
    severity: FailureSeverity;
    description: string;
  }): void {
    this.patterns.set(randomUUID(), params);
  }

  /**
   * Hata analizi yap.
   */
  analyze(failure: {
    message: string;
    stackTrace?: string | undefined;
    context?: Record<string, unknown>;
  }): FailureAnalysis | null {
    const combinedText = `${failure.message} ${failure.stackTrace ?? ""}`;

    for (const [, pattern] of this.patterns) {
      if (pattern.pattern.test(combinedText)) {
        return {
          id: randomUUID(),
          failureId: "",
          level: "deterministic",
          rootCause: pattern.description,
          contributingFactors: [],
          suggestedFixes: this.getSuggestedFixes(pattern.category),
          confidence: 0.8,
          analyzedAt: new Date().toISOString(),
        };
      }
    }

    return null;
  }

  /**
   * Kategori için önerilen düzeltmeleri al.
   */
  private getSuggestedFixes(category: FailureCategory): string[] {
    const fixes: Record<FailureCategory, string[]> = {
      knowledge: ["Add missing knowledge", "Update knowledge base", "Query external source"],
      tool: ["Check tool availability", "Update tool configuration", "Use alternative tool"],
      skill: ["Learn new skill", "Practice skill", "Find skill template"],
      interface: ["Check interface contract", "Update interface", "Use adapter pattern"],
      permission: ["Request permission", "Use alternative credentials", "Contact admin"],
      resource: ["Free resources", "Increase quota", "Optimize resource usage"],
      network: ["Retry connection", "Check network status", "Use fallback endpoint"],
      timeout: ["Increase timeout", "Optimize operation", "Use async processing"],
      validation: ["Fix input data", "Update validation rules", "Use different format"],
      logic: ["Review logic", "Add error handling", "Use defensive programming"],
      unknown: ["Investigate further", "Add logging", "Contact support"],
    };

    return fixes[category] ?? ["Investigate further"];
  }
}

/**
 * Structural Analyzer
 * 
 * Code structure analizi ile hata analizi.
 */
export class StructuralAnalyzer {
  /**
   * Hata analizi yap.
   */
  analyze(failure: {
    message: string;
    stackTrace?: string | undefined;
    code?: string;
    context?: Record<string, unknown>;
  }): FailureAnalysis | null {
    if (!failure.stackTrace) return null;

    // Stack trace analizi
    const lines = failure.stackTrace.split("\n");
    const relevantLines = lines.filter(line =>
      line.includes("at ") && !line.includes("node_modules")
    );

    if (relevantLines.length === 0) return null;

    // İlk hatayı bul
    const firstErrorLine = relevantLines[0];
    const match = firstErrorLine?.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);

    if (!match) return null;

    const [, functionName, fileName, lineNumber] = match;

    return {
      id: randomUUID(),
      failureId: "",
      level: "structural",
      rootCause: `Error in ${functionName} at ${fileName}:${lineNumber}`,
      contributingFactors: relevantLines.slice(1, 4).map(line => line.trim()),
      suggestedFixes: [
        `Check ${functionName} function`,
        `Review ${fileName} around line ${lineNumber}`,
        "Add error handling",
      ],
      confidence: 0.7,
      analyzedAt: new Date().toISOString(),
    };
  }
}

/**
 * LLM Analyzer
 * 
 * LLM ile hata analizi.
 */
export class LLMAnalyzer {
  constructor(
    private llmProvider?: {
      analyze(prompt: string): Promise<string>;
    }
  ) {}

  /**
   * Hata analizi yap.
   */
  async analyze(failure: {
    message: string;
    stackTrace?: string | undefined;
    code?: string;
    context?: Record<string, unknown>;
  }): Promise<FailureAnalysis | null> {
    if (!this.llmProvider) return null;

    const prompt = `Analyze this failure and provide:
1. Root cause
2. Contributing factors
3. Suggested fixes

Failure message: ${failure.message}
${failure.stackTrace ? `Stack trace:\n${failure.stackTrace}` : ""}
${failure.code ? `Code:\n${failure.code}` : ""}
${failure.context ? `Context:\n${JSON.stringify(failure.context, null, 2)}` : ""}`;

    try {
      const response = await this.llmProvider.analyze(prompt);

      return {
        id: randomUUID(),
        failureId: "",
        level: "llm",
        rootCause: response,
        contributingFactors: [],
        suggestedFixes: [],
        confidence: 0.6,
        analyzedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }
}

/**
 * Gap Engine
 * 
 * Failure classification ve analysis.
 */
export class GapEngine {
  private readonly failures = new Map<string, FailureRecord>();
  private readonly patterns = new Map<string, FailurePattern>();
  private readonly recommendations = new Map<string, GapRecommendation>();

  private readonly deterministicAnalyzer: DeterministicAnalyzer;
  private readonly structuralAnalyzer: StructuralAnalyzer;
  private readonly llmAnalyzer: LLMAnalyzer;

  constructor(llmProvider?: { analyze(prompt: string): Promise<string> }) {
    this.deterministicAnalyzer = new DeterministicAnalyzer();
    this.structuralAnalyzer = new StructuralAnalyzer();
    this.llmAnalyzer = new LLMAnalyzer(llmProvider);
  }

  /**
   * Hata kaydet.
   */
  recordFailure(params: {
    message: string;
    category?: FailureCategory;
    severity?: FailureSeverity;
    stackTrace?: string;
    code?: string;
    context?: Record<string, unknown>;
  }): FailureRecord {
    // Kategori belirle
    const category = params.category ?? this.classifyFailure(params.message);
    const severity = params.severity ?? this.determineSeverity(category);

    const failure: FailureRecord = {
      id: randomUUID(),
      category,
      severity,
      description: params.message,
      context: params.context ?? {},
      stackTrace: params.stackTrace,
      timestamp: new Date().toISOString(),
      resolved: false,
    };

    this.failures.set(failure.id, failure);

    // Pattern güncelle
    this.updatePatterns(failure);

    return failure;
  }

  /**
   * Hata sınıflandır.
   */
  private classifyFailure(message: string): FailureCategory {
    const msgLower = message.toLowerCase();

    if (msgLower.includes("tool") || msgLower.includes("capability")) return "tool";
    if (msgLower.includes("permission") || msgLower.includes("access")) return "permission";
    if (msgLower.includes("network") || msgLower.includes("connection")) return "network";
    if (msgLower.includes("timeout") || msgLower.includes("deadline")) return "timeout";
    if (msgLower.includes("validation") || msgLower.includes("invalid")) return "validation";
    if (msgLower.includes("not found") || msgLower.includes("unknown")) return "knowledge";
    if (msgLower.includes("memory") || msgLower.includes("resource")) return "resource";
    if (msgLower.includes("skill") || msgLower.includes("ability")) return "skill";
    if (msgLower.includes("interface") || msgLower.includes("contract")) return "interface";

    return "unknown";
  }

  /**
   * Severity belirle.
   */
  private determineSeverity(category: FailureCategory): FailureSeverity {
    const severityMap: Record<FailureCategory, FailureSeverity> = {
      knowledge: "medium",
      tool: "high",
      skill: "medium",
      interface: "medium",
      permission: "high",
      resource: "critical",
      network: "medium",
      timeout: "high",
      validation: "medium",
      logic: "high",
      unknown: "medium",
    };

    return severityMap[category] ?? "medium";
  }

  /**
   * Pattern güncelle.
   */
  private updatePatterns(failure: FailureRecord): void {
    const key = `${failure.category}-${failure.description.slice(0, 50)}`;
    const existing = this.patterns.get(key);

    if (existing) {
      existing.frequency++;
      existing.lastSeen = failure.timestamp;
      if (!existing.examples.includes(failure.id)) {
        existing.examples.push(failure.id);
        if (existing.examples.length > 10) {
          existing.examples = existing.examples.slice(-10);
        }
      }
    } else {
      this.patterns.set(key, {
        id: randomUUID(),
        category: failure.category,
        description: failure.description.slice(0, 200),
        frequency: 1,
        examples: [failure.id],
        firstSeen: failure.timestamp,
        lastSeen: failure.timestamp,
      });
    }
  }

  /**
   * Hata analizi yap.
   */
  async analyzeFailure(failureId: string): Promise<FailureAnalysis | null> {
    const failure = this.failures.get(failureId);
    if (!failure) return null;

    const context = {
      message: failure.description,
      stackTrace: failure.stackTrace,
      context: failure.context,
    };

    // Deterministic analiz
    let analysis = this.deterministicAnalyzer.analyze(context);

    // Structural analiz
    if (!analysis) {
      analysis = this.structuralAnalyzer.analyze(context);
    }

    // LLM analiz
    if (!analysis) {
      analysis = await this.llmAnalyzer.analyze(context);
    }

    if (analysis) {
      analysis.failureId = failureId;
      failure.analysis = analysis;
    }

    return analysis;
  }

  /**
   * Gap analizi yap.
   */
  async analyzeGaps(): Promise<GapAnalysisResult> {
    const failures = [...this.failures.values()];
    const patterns = [...this.patterns.values()];

    // Öneriler oluştur
    const recommendations = this.generateRecommendations(failures, patterns);

    return {
      id: randomUUID(),
      failures,
      patterns,
      recommendations,
      analyzedAt: new Date().toISOString(),
    };
  }

  /**
   * Öneriler oluştur.
   */
  private generateRecommendations(
    failures: FailureRecord[],
    patterns: FailurePattern[]
  ): GapRecommendation[] {
    const recommendations: GapRecommendation[] = [];

    // En sık görülen pattern'ler için öneriler
    const sortedPatterns = [...patterns].sort((a, b) => b.frequency - a.frequency);

    for (const pattern of sortedPatterns.slice(0, 5)) {
      recommendations.push({
        id: randomUUID(),
        type: "fix",
        description: `Fix recurring ${pattern.category} issue: ${pattern.description}`,
        priority: pattern.frequency > 5 ? "critical" : pattern.frequency > 3 ? "high" : "medium",
        estimatedEffort: pattern.frequency > 5 ? "high" : "medium",
        relatedFailures: pattern.examples,
      });
    }

    // Critical severity'li hatalar için öneriler
    const criticalFailures = failures.filter(f => f.severity === "critical" && !f.resolved);
    if (criticalFailures.length > 0) {
      recommendations.push({
        id: randomUUID(),
        type: "prevent",
        description: `Address ${criticalFailures.length} critical failures`,
        priority: "critical",
        estimatedEffort: "high",
        relatedFailures: criticalFailures.map(f => f.id),
      });
    }

    return recommendations;
  }

  /**
   * Hata çöz.
   */
  resolveFailure(failureId: string, resolution: string): boolean {
    const failure = this.failures.get(failureId);
    if (!failure) return false;

    failure.resolved = true;
    failure.resolution = resolution;
    return true;
  }

  /**
   * Tüm hataları al.
   */
  getFailures(): FailureRecord[] {
    return [...this.failures.values()];
  }

  /**
   * Unresolved hataları al.
   */
  getUnresolvedFailures(): FailureRecord[] {
    return [...this.failures.values()].filter(f => !f.resolved);
  }

  /**
   * Pattern'leri al.
   */
  getPatterns(): FailurePattern[] {
    return [...this.patterns.values()];
  }

  /**
   * Önerileri al.
   */
  getRecommendations(): GapRecommendation[] {
    const result = this.generateRecommendations(
      [...this.failures.values()],
      [...this.patterns.values()]
    );
    return result;
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalFailures: number;
    unresolvedFailures: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
    totalPatterns: number;
    totalRecommendations: number;
  } {
    const failures = [...this.failures.values()];
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};

    for (const failure of failures) {
      byCategory[failure.category] = (byCategory[failure.category] ?? 0) + 1;
      bySeverity[failure.severity] = (bySeverity[failure.severity] ?? 0) + 1;
    }

    return {
      totalFailures: failures.length,
      unresolvedFailures: failures.filter(f => !f.resolved).length,
      byCategory,
      bySeverity,
      totalPatterns: this.patterns.size,
      totalRecommendations: this.getRecommendations().length,
    };
  }
}
