/**
 * Security System — Aurora Cognitive Runtime
 *
 * SecurityContextItem with trust levels.
 * Capability approval matrix.
 * Kill switch.
 */

import { randomUUID } from "node:crypto";

/**
 * Trust level.
 */
export type TrustLevel = "untrusted" | "low" | "medium" | "high" | "trusted";

/**
 * Context item.
 */
export interface SecurityContextItem {
  id: string;
  type: string;
  content: unknown;
  trustLevel: TrustLevel;
  source: string;
  verified: boolean;
  timestamp: string;
}

/**
 * Capability approval.
 */
export interface CapabilityApproval {
  id: string;
  capabilityId: string;
  requiredTrust: TrustLevel;
  approvedBy: string;
  approvedAt: string;
  expiresAt?: string | undefined;
  conditions: string[];
}

/**
 * Kill switch.
 */
export interface KillSwitch {
  id: string;
  name: string;
  description: string;
  triggered: boolean;
  triggeredAt?: string | undefined;
  triggeredBy?: string | undefined;
  reason?: string | undefined;
  autoReset: boolean;
  resetAfterMs?: number | undefined;
}

/**
 * Security event.
 */
export interface SecurityEvent {
  id: string;
  type: "trust_violation" | "approval_denied" | "kill_switch_triggered" | "injection_detected";
  severity: "low" | "medium" | "high" | "critical";
  details: string;
  timestamp: string;
}

/**
 * Trust Manager
 * 
 * SecurityContextItem with trust levels.
 */
export class TrustManager {
  private readonly contextItems = new Map<string, SecurityContextItem>();
  private readonly trustPolicies = new Map<string, {
    source: string;
    minTrust: TrustLevel;
  }>();

  /**
   * Trust level sırası.
   */
  private readonly trustOrder: TrustLevel[] = ["untrusted", "low", "medium", "high", "trusted"];

  /**
   * Trust level'ları karşılaştır.
   */
  compareTrust(level1: TrustLevel, level2: TrustLevel): number {
    return this.trustOrder.indexOf(level1) - this.trustOrder.indexOf(level2);
  }

  /**
   * Trust level yeterli mi?
   */
  isTrustSufficient(actual: TrustLevel, required: TrustLevel): boolean {
    return this.compareTrust(actual, required) >= 0;
  }

  /**
   * Context item ekle.
   */
  addSecurityContextItem(params: {
    type: string;
    content: unknown;
    trustLevel: TrustLevel;
    source: string;
    verified?: boolean;
  }): SecurityContextItem {
    const id = randomUUID();
    const item: SecurityContextItem = {
      id,
      type: params.type,
      content: params.content,
      trustLevel: params.trustLevel,
      source: params.source,
      verified: params.verified ?? false,
      timestamp: new Date().toISOString(),
    };
    this.contextItems.set(id, item);
    return item;
  }

  /**
   * Trust policy ekle.
   */
  addTrustPolicy(params: {
    source: string;
    minTrust: TrustLevel;
  }): void {
    this.trustPolicies.set(params.source, params);
  }

  /**
   * Context item'ın trust policy'ye uygun olup olmadığını kontrol et.
   */
  checkTrustPolicy(itemId: string): boolean {
    const item = this.contextItems.get(itemId);
    if (!item) return false;

    const policy = this.trustPolicies.get(item.source);
    if (!policy) return true; // Policy yoksa kabul et

    return this.isTrustSufficient(item.trustLevel, policy.minTrust);
  }

  /**
   * Context item'ları al.
   */
  getSecurityContextItems(): SecurityContextItem[] {
    return [...this.contextItems.values()];
  }

  /**
   * Trust level'a göre context item'ları al.
   */
  getSecurityContextItemsByTrust(trustLevel: TrustLevel): SecurityContextItem[] {
    return [...this.contextItems.values()].filter(i => i.trustLevel === trustLevel);
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalItems: number;
    verifiedItems: number;
    byTrustLevel: Record<string, number>;
    totalPolicies: number;
  } {
    const items = [...this.contextItems.values()];
    const byTrustLevel: Record<string, number> = {};

    for (const item of items) {
      byTrustLevel[item.trustLevel] = (byTrustLevel[item.trustLevel] ?? 0) + 1;
    }

    return {
      totalItems: items.length,
      verifiedItems: items.filter(i => i.verified).length,
      byTrustLevel,
      totalPolicies: this.trustPolicies.size,
    };
  }
}

/**
 * Approval Matrix
 * 
 * Capability approval matrix.
 */
export class ApprovalMatrix {
  private readonly approvals = new Map<string, CapabilityApproval>();
  private readonly deniedRequests = new Map<string, {
    capabilityId: string;
    requestedBy: string;
    reason: string;
    timestamp: string;
  }>();

  /**
   * Capability approval ekle.
   */
  addApproval(params: {
    capabilityId: string;
    requiredTrust: TrustLevel;
    approvedBy: string;
    expiresAt?: string;
    conditions?: string[];
  }): CapabilityApproval {
    const id = randomUUID();
    const approval: CapabilityApproval = {
      id,
      capabilityId: params.capabilityId,
      requiredTrust: params.requiredTrust,
      approvedBy: params.approvedBy,
      approvedAt: new Date().toISOString(),
      expiresAt: params.expiresAt,
      conditions: params.conditions ?? [],
    };
    this.approvals.set(id, approval);
    return approval;
  }

  /**
   * Capability'nin approved olup olmadığını kontrol et.
   */
  isApproved(capabilityId: string, trustLevel: TrustLevel): boolean {
    const approval = [...this.approvals.values()].find(a => a.capabilityId === capabilityId);
    if (!approval) return false;

    // Expiration kontrolü
    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      return false;
    }

    // Trust level kontrolü
    const trustManager = new TrustManager();
    return trustManager.isTrustSufficient(trustLevel, approval.requiredTrust);
  }

  /**
   * Reddedilen istek kaydet.
   */
  denyRequest(params: {
    capabilityId: string;
    requestedBy: string;
    reason: string;
  }): void {
    this.deniedRequests.set(randomUUID(), {
      ...params,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Approval'ları al.
   */
  getApprovals(): CapabilityApproval[] {
    return [...this.approvals.values()];
  }

  /**
   * Reddedilen istekleri al.
   */
  getDeniedRequests(): Array<{
    capabilityId: string;
    requestedBy: string;
    reason: string;
    timestamp: string;
  }> {
    return [...this.deniedRequests.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalApprovals: number;
    totalDenied: number;
    activeApprovals: number;
  } {
    const approvals = [...this.approvals.values()];
    const now = new Date();
    return {
      totalApprovals: approvals.length,
      totalDenied: this.deniedRequests.size,
      activeApprovals: approvals.filter(a =>
        !a.expiresAt || new Date(a.expiresAt) > now
      ).length,
    };
  }
}

/**
 * Kill Switch Manager
 * 
 * Kill switch.
 */
export class KillSwitchManager {
  private readonly killSwitches = new Map<string, KillSwitch>();
  private readonly securityEvents = new Map<string, SecurityEvent>();

  /**
   * Kill switch oluştur.
   */
  createKillSwitch(params: {
    name: string;
    description: string;
    autoReset?: boolean;
    resetAfterMs?: number;
  }): KillSwitch {
    const id = randomUUID();
    const killSwitch: KillSwitch = {
      id,
      name: params.name,
      description: params.description,
      triggered: false,
      autoReset: params.autoReset ?? false,
      resetAfterMs: params.resetAfterMs,
    };
    this.killSwitches.set(id, killSwitch);
    return killSwitch;
  }

  /**
   * Kill switch'i tetikle.
   */
  trigger(killSwitchId: string, triggeredBy: string, reason: string): boolean {
    const killSwitch = this.killSwitches.get(killSwitchId);
    if (!killSwitch) return false;

    killSwitch.triggered = true;
    killSwitch.triggeredAt = new Date().toISOString();
    killSwitch.triggeredBy = triggeredBy;
    killSwitch.reason = reason;

    // Security event oluştur
    this.addSecurityEvent({
      type: "kill_switch_triggered",
      severity: "critical",
      details: `Kill switch "${killSwitch.name}" triggered by ${triggeredBy}: ${reason}`,
    });

    // Auto-reset
    if (killSwitch.autoReset && killSwitch.resetAfterMs) {
      setTimeout(() => {
        this.reset(killSwitchId);
      }, killSwitch.resetAfterMs);
    }

    return true;
  }

  /**
   * Kill switch'i reset'le.
   */
  reset(killSwitchId: string): boolean {
    const killSwitch = this.killSwitches.get(killSwitchId);
    if (!killSwitch) return false;

    killSwitch.triggered = false;
    killSwitch.triggeredAt = undefined;
    killSwitch.triggeredBy = undefined;
    killSwitch.reason = undefined;

    return true;
  }

  /**
   * Kill switch'in tetiklenip tetiklenmediğini kontrol et.
   */
  isTriggered(killSwitchId: string): boolean {
    return this.killSwitches.get(killSwitchId)?.triggered ?? false;
  }

  /**
   * Herhangi bir kill switch'in tetiklenip tetiklenmediğini kontrol et.
   */
  isAnyTriggered(): boolean {
    return [...this.killSwitches.values()].some(ks => ks.triggered);
  }

  /**
   * Security event ekle.
   */
  addSecurityEvent(params: {
    type: SecurityEvent["type"];
    severity: SecurityEvent["severity"];
    details: string;
  }): SecurityEvent {
    const id = randomUUID();
    const event: SecurityEvent = {
      id,
      type: params.type,
      severity: params.severity,
      details: params.details,
      timestamp: new Date().toISOString(),
    };
    this.securityEvents.set(id, event);
    // P2.42: security events are evidence, and evidence that only lives in a
    // Map dies with the process. The sink (wired by the engine to a durable
    // JSONL file) is optional so the class stays usable standalone; when it
    // is absent the event still exists in memory, and the audit query says
    // which store it came from instead of pretending durability.
    if (this.auditSink) {
      try {
        this.auditSink(event);
      } catch {
        // A failed durable append must not break the security path itself.
      }
    }
    return event;
  }

  private auditSink?: (event: SecurityEvent) => void;

  setAuditSink(sink: (event: SecurityEvent) => void): void {
    this.auditSink = sink;
  }

  /**
   * Kill switch'leri al.
   */
  getKillSwitches(): KillSwitch[] {
    return [...this.killSwitches.values()];
  }

  /**
   * Security event'leri al.
   */
  getSecurityEvents(): SecurityEvent[] {
    return [...this.securityEvents.values()];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalKillSwitches: number;
    triggeredKillSwitches: number;
    totalSecurityEvents: number;
    criticalEvents: number;
  } {
    const killSwitches = [...this.killSwitches.values()];
    const events = [...this.securityEvents.values()];
    return {
      totalKillSwitches: killSwitches.length,
      triggeredKillSwitches: killSwitches.filter(ks => ks.triggered).length,
      totalSecurityEvents: events.length,
      criticalEvents: events.filter(e => e.severity === "critical").length,
    };
  }
}

/**
 * Injection Detector
 * 
 * Injection detection.
 */
/**
 * Which layer a pattern is about.
 *
 * The distinction matters at the capability boundary. "payload" patterns
 * describe characters that are dangerous when a string reaches an interpreter
 * — a shell, SQL, a path resolver. But a shell capability exists to receive
 * `&&` and `$VAR`, and a patch capability legitimately carries `../` inside a
 * diff; those callers have their own escaping and their own workspace checks,
 * and rejecting the input wholesale breaks the capability while a narrower,
 * better-worded check downstream already covers it.
 *
 * "prompt" patterns describe untrusted text trying to redirect the agent
 * itself. No downstream escaping helps there — the interpreter is the model —
 * so those are the ones worth blocking centrally.
 */
export type InjectionTarget = "payload" | "prompt";

export class InjectionDetector {
  private readonly patterns = new Map<string, {
    name: string;
    pattern: RegExp;
    severity: SecurityEvent["severity"];
    target: InjectionTarget;
  }>();

  /**
   * Varsayılan pattern'leri ekle.
   */
  addDefaultPatterns(): void {
    const defaults = [
      {
        name: "SQL Injection",
        pattern: /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION)\b.*\b(FROM|INTO|WHERE)\b)/i,
        severity: "critical" as SecurityEvent["severity"],
        target: "payload" as InjectionTarget,
      },
      {
        name: "Command Injection",
        pattern: /[;&|`$]/,
        severity: "high" as SecurityEvent["severity"],
        target: "payload" as InjectionTarget,
      },
      {
        name: "Path Traversal",
        pattern: /\.\.\//,
        severity: "high" as SecurityEvent["severity"],
        target: "payload" as InjectionTarget,
      },
      {
        name: "Script Injection",
        pattern: /<script\b[^>]*>.*?<\/script>/is,
        severity: "critical" as SecurityEvent["severity"],
        target: "payload" as InjectionTarget,
      },
      // ── Prompt injection (FAZ 39-41) ──
      // Untrusted content trying to override the operating instructions.
      {
        name: "Instruction Override",
        pattern:
          /\b(ignore|disregard|forget|override)\b[\s\S]{0,40}\b(all\s+)?(previous|prior|above|earlier|system)\b[\s\S]{0,20}\b(instruction|prompt|rule|direction|message)s?\b/i,
        severity: "critical" as SecurityEvent["severity"],
        target: "prompt" as InjectionTarget,
      },
      {
        name: "System Prompt Exfiltration",
        pattern:
          /\b(reveal|show|print|output|repeat|disclose|leak)\b[\s\S]{0,30}\b(your\s+)?(system\s+prompt|initial\s+instructions|hidden\s+instructions|developer\s+message)\b/i,
        severity: "critical" as SecurityEvent["severity"],
        target: "prompt" as InjectionTarget,
      },
      {
        name: "Role Hijack",
        pattern:
          /\b(you\s+are\s+now|from\s+now\s+on\s+you|act\s+as|pretend\s+to\s+be|roleplay\s+as)\b[\s\S]{0,40}\b(dan|developer\s+mode|unrestricted|jailbroken|no\s+longer\s+bound)\b/i,
        severity: "high" as SecurityEvent["severity"],
        target: "prompt" as InjectionTarget,
      },
      {
        name: "Safety Bypass Request",
        pattern:
          /\b(bypass|disable|turn\s+off|circumvent|ignore)\b[\s\S]{0,30}\b(safety|guardrail|filter|restriction|policy|content\s+polic)\w*\b/i,
        severity: "high" as SecurityEvent["severity"],
        target: "prompt" as InjectionTarget,
      },
      {
        name: "Credential Exfiltration",
        pattern:
          /\b(send|post|upload|exfiltrate|transmit|email)\b[\s\S]{0,40}\b(api[\s_-]?key|secret|token|password|credential|\.env)\b/i,
        severity: "critical" as SecurityEvent["severity"],
        target: "prompt" as InjectionTarget,
      },
    ];

    for (const pattern of defaults) {
      this.addPattern(pattern);
    }
  }

  /**
   * Pattern ekle.
   */
  addPattern(params: {
    name: string;
    pattern: RegExp;
    severity: SecurityEvent["severity"];
    target?: InjectionTarget | undefined;
  }): void {
    this.patterns.set(params.name, { ...params, target: params.target ?? "payload" });
  }

  /**
   * Input'ta injection kontrolü yap.
   */
  detect(input: string, target?: InjectionTarget): Array<{
    pattern: string;
    severity: SecurityEvent["severity"];
    match: string;
  }> {
    const detections: Array<{
      pattern: string;
      severity: SecurityEvent["severity"];
      match: string;
    }> = [];

    for (const [name, pattern] of this.patterns) {
      if (target !== undefined && pattern.target !== target) continue;
      const match = input.match(pattern.pattern);
      if (match) {
        detections.push({
          pattern: name,
          severity: pattern.severity,
          match: match[0],
        });
      }
    }

    return detections;
  }

  /**
   * Injection taraması yap ve özet bir karar döndür.
   *
   * `detect()` ham eşleşme listesi verir; bu metot çağıranın doğrudan
   * kullanabileceği bir karar üretir. Varsayılan pattern'ler yüklenmemişse
   * otomatik yükler — boş bir dedektörün "temiz" raporlaması güvenlik açığıdır.
   */
  scan(input: string): {
    detected: boolean;
    highestSeverity: SecurityEvent["severity"] | "none";
    matches: Array<{
      pattern: string;
      severity: SecurityEvent["severity"];
      match: string;
    }>;
  } {
    if (this.patterns.size === 0) {
      this.addDefaultPatterns();
    }

    const matches = this.detect(input);
    if (matches.length === 0) {
      return { detected: false, highestSeverity: "none", matches: [] };
    }

    const order: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    let highest = matches[0]!.severity;
    for (const m of matches) {
      if ((order[m.severity] ?? 0) > (order[highest] ?? 0)) highest = m.severity;
    }

    return { detected: true, highestSeverity: highest, matches };
  }

  /**
   * Pattern'leri al.
   */
  getPatterns(): Array<{
    name: string;
    severity: SecurityEvent["severity"];
    target: InjectionTarget;
  }> {
    return [...this.patterns.values()].map(p => ({
      name: p.name,
      severity: p.severity,
      target: p.target,
    }));
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalPatterns: number;
  } {
    return {
      totalPatterns: this.patterns.size,
    };
  }
}

/**
 * Security System Pipeline
 * 
 * Trust levels + Approval matrix + Kill switch + Injection detection.
 */
export class SecuritySystemPipeline {
  readonly trustManager: TrustManager;
  readonly approvalMatrix: ApprovalMatrix;
  readonly killSwitchManager: KillSwitchManager;
  readonly injectionDetector: InjectionDetector;

  constructor() {
    this.trustManager = new TrustManager();
    this.approvalMatrix = new ApprovalMatrix();
    this.killSwitchManager = new KillSwitchManager();
    this.injectionDetector = new InjectionDetector();
  }

  /**
   * Security system'i başlat.
   */
  initialize(): void {
    // Injection pattern'leri ekle
    this.injectionDetector.addDefaultPatterns();

    // Varsayılan kill switch'ler oluştur
    this.killSwitchManager.createKillSwitch({
      name: "Emergency Stop",
      description: "Emergency stop for all operations",
      autoReset: false,
    });

    this.killSwitchManager.createKillSwitch({
      name: "Rate Limiter",
      description: "Rate limit exceeded",
      autoReset: true,
      resetAfterMs: 60000, // 1 minute
    });

    // Trust policy'leri ekle
    this.trustManager.addTrustPolicy({
      source: "external",
      minTrust: "medium",
    });

    this.trustManager.addTrustPolicy({
      source: "internal",
      minTrust: "low",
    });

    // Capability approval'ları ekle
    this.approvalMatrix.addApproval({
      capabilityId: "file-read",
      requiredTrust: "low",
      approvedBy: "system",
    });

    this.approvalMatrix.addApproval({
      capabilityId: "file-write",
      requiredTrust: "medium",
      approvedBy: "system",
    });

    this.approvalMatrix.addApproval({
      capabilityId: "code-execution",
      requiredTrust: "high",
      approvedBy: "admin",
      conditions: ["sandboxed", "timeout"],
    });
  }

  /**
   * Security check yap.
   */
  /**
   * Screens arbitrary text -- a task goal, a tool argument, retrieved context --
   * for injection, without routing it through the capability approval matrix.
   *
   * This existed as a gap rather than a design choice. `checkSecurity` is a
   * gate for *invoking a capability*: kill switch, injection, trust policy, then
   * `approvalMatrix.isApproved(capabilityId, trustLevel)`. Text that is not a
   * capability has no entry in that matrix, so passing it through `checkSecurity`
   * was refused at step 4 with "Capability not approved for this trust level" --
   * measured, every benign goal was blocked, which is a screening layer that
   * fails closed on everything and is therefore useless.
   *
   * What this does check, and does not weaken:
   *
   *   - The kill switch still applies. If it is triggered, nothing is screened
   *     as safe.
   *   - Injection detection is the same detector `checkSecurity` uses, and a
   *     detection still raises a security event, so the event log sees it.
   *
   * What it deliberately does not do: decide whether a capability may run. That
   * is `checkSecurity`'s job and it stays there.
   */
  async screenText(input: string): Promise<{
    allowed: boolean;
    reason: string;
    detections: Array<{ pattern: string; severity: string; match: string }>;
  }> {
    if (this.killSwitchManager.isAnyTriggered()) {
      return { allowed: false, reason: "Kill switch is triggered", detections: [] };
    }

    const detections = this.injectionDetector.detect(input);
    if (detections.length > 0) {
      this.killSwitchManager.addSecurityEvent({
        type: "injection_detected",
        severity: "critical",
        details: `Injection detected: ${detections.map((item) => item.pattern).join(", ")}`,
      });
      return { allowed: false, reason: "Injection detected", detections };
    }

    return { allowed: true, reason: "No injection signature found", detections: [] };
  }

  async checkSecurity(params: {
    input: string;
    capabilityId: string;
    trustLevel: TrustLevel;
    source: string;
  }): Promise<{
    allowed: boolean;
    reason: string;
    detections: Array<{ pattern: string; severity: string; match: string }>;
  }> {
    // 1. Kill switch kontrolü
    if (this.killSwitchManager.isAnyTriggered()) {
      return {
        allowed: false,
        reason: "Kill switch is triggered",
        detections: [],
      };
    }

    // 2. Injection detection
    const detections = this.injectionDetector.detect(params.input);
    if (detections.length > 0) {
      this.killSwitchManager.addSecurityEvent({
        type: "injection_detected",
        severity: "critical",
        details: `Injection detected: ${detections.map(d => d.pattern).join(", ")}`,
      });

      return {
        allowed: false,
        reason: "Injection detected",
        detections,
      };
    }

    // 3. Trust level kontrolü
    const trustPolicy = this.trustManager.checkTrustPolicy(
      this.trustManager.addSecurityContextItem({
        type: "request",
        content: params.input,
        trustLevel: params.trustLevel,
        source: params.source,
      }).id
    );

    if (!trustPolicy) {
      this.killSwitchManager.addSecurityEvent({
        type: "trust_violation",
        severity: "high",
        details: `Trust level insufficient: ${params.trustLevel}`,
      });

      return {
        allowed: false,
        reason: "Trust level insufficient",
        detections: [],
      };
    }

    // 4. Approval kontrolü
    if (!this.approvalMatrix.isApproved(params.capabilityId, params.trustLevel)) {
      this.approvalMatrix.denyRequest({
        capabilityId: params.capabilityId,
        requestedBy: params.source,
        reason: "Insufficient trust level",
      });

      return {
        allowed: false,
        reason: "Capability not approved for this trust level",
        detections: [],
      };
    }

    return {
      allowed: true,
      reason: "Security check passed",
      detections: [],
    };
  }

  /**
   * Pipeline istatistiklerini al.
   */
  getStats(): {
    trustManager: ReturnType<TrustManager["getStats"]>;
    approvalMatrix: ReturnType<ApprovalMatrix["getStats"]>;
    killSwitchManager: ReturnType<KillSwitchManager["getStats"]>;
    injectionDetector: ReturnType<InjectionDetector["getStats"]>;
  } {
    return {
      trustManager: this.trustManager.getStats(),
      approvalMatrix: this.approvalMatrix.getStats(),
      killSwitchManager: this.killSwitchManager.getStats(),
      injectionDetector: this.injectionDetector.getStats(),
    };
  }
}
