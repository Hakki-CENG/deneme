import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CapabilityRisk } from "../types.js";
import { auroraDigest, auroraInteger, auroraRound, auroraText, DurableJsonState } from "../util/aurora-state.js";

const MAX_ASSESSMENTS = 100_000;
const MAX_RULES = 500;

export type RiskLevel = "low" | "medium" | "high" | "critical";
/** How much human confirmation the tenant wants: `all` confirms everything, `never` only criticals. */
export type ConfirmationMode = "never" | "critical" | "high" | "medium" | "all";

export interface RiskRule {
  id: string;
  tenantId: string;
  code: string;
  description: string;
  level: RiskLevel;
  pattern: string;
  appliesToCapabilityIds: string[];
  builtin: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface RiskAssessment {
  id: string;
  tenantId: string;
  sessionId?: string;
  capabilityId: string;
  declaredRisk: CapabilityRisk;
  level: RiskLevel;
  score: number;
  requiresConfirmation: boolean;
  matchedRules: Array<{ code: string; level: RiskLevel; description: string }>;
  reasons: string[];
  argumentDigest: string;
  zoneHint: 0 | 1 | 2 | 3 | 4;
  assessedAt: string;
}

export interface ConfirmationPolicy {
  tenantId: string;
  mode: ConfirmationMode;
  autoDenyCritical: boolean;
  updatedAt: string;
}

interface RiskStateShape {
  schemaVersion: 1;
  rules: RiskRule[];
  assessments: RiskAssessment[];
  policies: ConfirmationPolicy[];
}

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const LEVEL_SCORE: Record<RiskLevel, number> = { low: 0.15, medium: 0.45, high: 0.75, critical: 0.95 };
const RISK_BASELINE: Record<CapabilityRisk, RiskLevel> = {
  pure: "low",
  workspace_read: "low",
  workspace_write: "medium",
  process: "high",
  network: "medium",
  external_side_effect: "high",
  privileged: "high",
};

/** Built-in destructive-pattern catalog distilled from real agent incidents. */
const BUILTIN_RULES: Array<{ code: string; description: string; level: RiskLevel; pattern: string; capabilities?: string[] }> = [
  { code: "RM-RECURSIVE-ROOT", description: "Recursive delete of a root or home path.", level: "critical", pattern: "rm\\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\\s+(/|~|\\$HOME)(\\s|$)" },
  { code: "RM-RECURSIVE", description: "Recursive force delete.", level: "high", pattern: "rm\\s+-[a-z]*r[a-z]*f" },
  { code: "DISK-WIPE", description: "Direct block-device write or filesystem format.", level: "critical", pattern: "\\b(mkfs(\\.[a-z0-9]+)?|dd\\s+if=[^\\s]+\\s+of=/dev/)\\b" },
  { code: "FORK-BOMB", description: "Fork bomb or unbounded process spawn.", level: "critical", pattern: ":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:" },
  { code: "GIT-FORCE-PUSH", description: "Force push rewrites remote history.", level: "high", pattern: "git\\s+push\\b[^\\n]*\\s(--force|-f)\\b" },
  { code: "GIT-HARD-RESET", description: "Hard reset discards uncommitted work.", level: "medium", pattern: "git\\s+reset\\s+--hard\\b" },
  { code: "GIT-CLEAN", description: "git clean removes untracked files permanently.", level: "medium", pattern: "git\\s+clean\\s+-[a-z]*f" },
  { code: "SQL-DROP", description: "Destructive SQL schema or table removal.", level: "critical", pattern: "\\b(DROP\\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\\s+TABLE)\\b" },
  { code: "SQL-UNSCOPED-DELETE", description: "DELETE or UPDATE without a WHERE clause.", level: "high", pattern: "\\b(DELETE\\s+FROM|UPDATE)\\s+[a-z_.\"`\\[\\]]+\\s*(;|$)" },
  { code: "CURL-PIPE-SHELL", description: "Remote script piped straight into a shell.", level: "critical", pattern: "\\b(curl|wget)\\b[^\\n|]*\\|\\s*(sudo\\s+)?(ba|z|k|)sh\\b" },
  { code: "PRIVILEGE-ESCALATION", description: "Privilege escalation via sudo/su/chmod 777.", level: "high", pattern: "\\b(sudo\\s+-i|sudo\\s+su|chmod\\s+(-R\\s+)?777)\\b" },
  { code: "CREDENTIAL-READ", description: "Reads a well-known credential store.", level: "high", pattern: "(\\.ssh/id_[a-z0-9]+|\\.aws/credentials|\\.netrc|/etc/shadow|\\.env(\\.|$)|id_rsa)" },
  { code: "CREDENTIAL-EXFIL", description: "Sends secret-looking material to the network.", level: "critical", pattern: "(api[_-]?key|secret|token|password)[^\\n]{0,40}(curl|wget|fetch|requests\\.post|http[s]?://)" },
  { code: "PACKAGE-GLOBAL-INSTALL", description: "Global package installation changes the host toolchain.", level: "medium", pattern: "\\b(npm\\s+i(nstall)?\\s+-g|pip\\s+install\\s+--(user|break-system-packages)|apt(-get)?\\s+install)\\b" },
  { code: "PROCESS-KILL-ALL", description: "Mass process termination.", level: "high", pattern: "\\b(killall|pkill\\s+-9|kill\\s+-9\\s+-1)\\b" },
  { code: "CRON-TAMPER", description: "Modifies scheduled jobs on the host.", level: "high", pattern: "\\b(crontab\\s+-r|systemctl\\s+(disable|mask))\\b" },
  { code: "HISTORY-TAMPER", description: "Attempts to erase audit or history trails.", level: "critical", pattern: "\\b(history\\s+-c|shred\\s+|>\\s*/var/log/)" },
  { code: "MASS-EMAIL", description: "Bulk outbound messaging.", level: "high", pattern: "\\b(sendmail|mailx|smtplib)\\b[^\\n]{0,80}\\b(all|bulk|list)\\b" },
];

/**
 * Aurora risk analyzer and confirmation policy (OpenHands security-analyzer derived).
 *
 * It is an *escalation-only* layer: it can raise the required scrutiny for a capability call and
 * recommend a safe execution zone, but it never grants authority. The policy engine, capability
 * allowlists and approval service stay authoritative — this only makes their decisions better informed.
 */
export class RiskAnalyzerService {
  private readonly store: DurableJsonState<RiskStateShape>;

  constructor(rootPath: string, private readonly now: () => number = Date.now) {
    this.store = new DurableJsonState<RiskStateShape>(
      join(rootPath, "risk", "state.json"),
      () => ({ schemaVersion: 1, rules: [], assessments: [], policies: [] }),
      (value) => {
        const state = value as RiskStateShape;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.rules) && Array.isArray(state.assessments) && Array.isArray(state.policies);
      },
      "Aurora risk analyzer",
    );
  }

  async rules(tenantId: string): Promise<RiskRule[]> {
    return await this.store.mutate((state) => {
      this.seed(state, tenantId);
      return state.rules.filter((item) => item.tenantId === tenantId).sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] || a.code.localeCompare(b.code)).map((item) => structuredClone(item));
    });
  }

  async addRule(input: { tenantId: string; code: string; description: string; level: RiskLevel; pattern: string; appliesToCapabilityIds?: string[] }): Promise<RiskRule> {
    return await this.store.mutate((state) => {
      this.seed(state, input.tenantId);
      if (state.rules.filter((item) => item.tenantId === input.tenantId).length >= MAX_RULES) throw new Error("Risk rule limit reached.");
      const code = auroraText(input.code, 60, "Risk rule code").toUpperCase();
      if (state.rules.some((item) => item.tenantId === input.tenantId && item.code === code)) throw new Error("Risk rule code already exists in tenant.");
      const pattern = auroraText(input.pattern, 2000, "Risk rule pattern");
      compilePattern(pattern);
      const rule: RiskRule = {
        id: `risk-rule-${randomUUID()}`,
        tenantId: input.tenantId,
        code,
        description: auroraText(input.description, 1000, "Risk rule description"),
        level: input.level,
        pattern,
        appliesToCapabilityIds: (input.appliesToCapabilityIds ?? []).slice(0, 100).map((item) => auroraText(item, 200, "Risk rule capability")),
        builtin: false,
        enabled: true,
        createdAt: new Date(this.now()).toISOString(),
      };
      state.rules.push(rule);
      return structuredClone(rule);
    });
  }

  async setRuleEnabled(tenantId: string, ruleId: string, enabled: boolean): Promise<RiskRule> {
    return await this.store.mutate((state) => {
      this.seed(state, tenantId);
      const rule = state.rules.find((item) => item.tenantId === tenantId && (item.id === ruleId || item.code === ruleId.toUpperCase()));
      if (!rule) throw new Error("Risk rule not found in tenant.");
      if (rule.builtin && rule.level === "critical" && !enabled) throw new Error("Built-in critical risk rules cannot be disabled.");
      rule.enabled = enabled;
      return structuredClone(rule);
    });
  }

  async policy(tenantId: string): Promise<ConfirmationPolicy> {
    return await this.store.mutate((state) => structuredClone(this.mutablePolicy(state, tenantId)));
  }

  async setPolicy(tenantId: string, mode: ConfirmationMode, autoDenyCritical?: boolean): Promise<ConfirmationPolicy> {
    return await this.store.mutate((state) => {
      const policy = this.mutablePolicy(state, tenantId);
      policy.mode = mode;
      if (autoDenyCritical !== undefined) policy.autoDenyCritical = autoDenyCritical;
      policy.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(policy);
    });
  }

  /**
   * Assess one proposed capability call. The declared capability risk sets the floor; matching
   * destructive patterns raise it. The result recommends a confirmation requirement and safe zone.
   */
  async assess(input: { tenantId: string; capabilityId: string; declaredRisk: CapabilityRisk; args?: unknown; sessionId?: string; record?: boolean }): Promise<RiskAssessment> {
    return await this.store.mutate((state) => {
      this.seed(state, input.tenantId);
      const policy = this.mutablePolicy(state, input.tenantId);
      const text = flattenArguments(input.args);
      const matched: RiskAssessment["matchedRules"] = [];
      let level: RiskLevel = RISK_BASELINE[input.declaredRisk] ?? "medium";
      const reasons: string[] = [`Declared capability risk "${input.declaredRisk}" implies a ${level} baseline.`];
      for (const rule of state.rules.filter((item) => item.tenantId === input.tenantId && item.enabled)) {
        if (rule.appliesToCapabilityIds.length && !rule.appliesToCapabilityIds.includes(input.capabilityId)) continue;
        const expression = compilePattern(rule.pattern);
        if (!expression.test(text)) continue;
        matched.push({ code: rule.code, level: rule.level, description: rule.description });
        if (LEVEL_ORDER[rule.level] > LEVEL_ORDER[level]) {
          level = rule.level;
          reasons.push(`Rule ${rule.code} raised the level to ${rule.level}: ${rule.description}`);
        } else {
          reasons.push(`Rule ${rule.code} matched (${rule.level}).`);
        }
      }
      const requiresConfirmation = this.requiresConfirmation(policy.mode, level);
      const assessment: RiskAssessment = {
        id: `risk-${randomUUID()}`,
        tenantId: input.tenantId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        capabilityId: auroraText(input.capabilityId, 200, "Capability ID"),
        declaredRisk: input.declaredRisk,
        level,
        score: auroraRound(Math.min(1, LEVEL_SCORE[level] + Math.min(0.2, matched.length * 0.05))),
        requiresConfirmation,
        matchedRules: matched,
        reasons,
        argumentDigest: auroraDigest(input.args ?? {}),
        zoneHint: zoneFor(level, input.declaredRisk),
        assessedAt: new Date(this.now()).toISOString(),
      };
      if (input.record !== false) {
        state.assessments.push(assessment);
        if (state.assessments.length > MAX_ASSESSMENTS) state.assessments.splice(0, state.assessments.length - MAX_ASSESSMENTS);
      }
      return structuredClone(assessment);
    });
  }

  async assessments(tenantId: string, filter?: { level?: RiskLevel; limit?: number }): Promise<RiskAssessment[]> {
    const state = await this.store.read();
    return state.assessments
      .filter((item) => item.tenantId === tenantId && (!filter?.level || item.level === filter.level))
      .sort((a, b) => b.assessedAt.localeCompare(a.assessedAt))
      .slice(0, auroraInteger(filter?.limit ?? 100, 1, 1000, "Assessment limit"))
      .map((item) => structuredClone(item));
  }

  /** Rolling risk posture: how much high-risk work is being proposed and how much is confirmed. */
  async posture(tenantId: string, windowDays = 7): Promise<{ tenantId: string; window: number; total: number; byLevel: Record<string, number>; confirmationRate: number; topRules: Array<{ code: string; count: number }>; generatedAt: string }> {
    const state = await this.store.read();
    const threshold = this.now() - auroraInteger(windowDays, 1, 365, "Posture window") * 86_400_000;
    const assessments = state.assessments.filter((item) => item.tenantId === tenantId && Date.parse(item.assessedAt) >= threshold);
    const byLevel: Record<string, number> = {};
    const ruleCounts = new Map<string, number>();
    for (const assessment of assessments) {
      byLevel[assessment.level] = (byLevel[assessment.level] ?? 0) + 1;
      for (const rule of assessment.matchedRules) ruleCounts.set(rule.code, (ruleCounts.get(rule.code) ?? 0) + 1);
    }
    return {
      tenantId,
      window: windowDays,
      total: assessments.length,
      byLevel,
      confirmationRate: assessments.length ? auroraRound(assessments.filter((item) => item.requiresConfirmation).length / assessments.length) : 0,
      topRules: [...ruleCounts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  private requiresConfirmation(mode: ConfirmationMode, level: RiskLevel): boolean {
    if (mode === "all") return true;
    if (mode === "never") return level === "critical";
    const floor: Record<Exclude<ConfirmationMode, "all" | "never">, RiskLevel> = { critical: "critical", high: "high", medium: "medium" };
    return LEVEL_ORDER[level] >= LEVEL_ORDER[floor[mode]];
  }

  private mutablePolicy(state: RiskStateShape, tenantId: string): ConfirmationPolicy {
    let policy = state.policies.find((item) => item.tenantId === tenantId);
    if (!policy) {
      policy = { tenantId, mode: "high", autoDenyCritical: false, updatedAt: new Date(this.now()).toISOString() };
      state.policies.push(policy);
    }
    return policy;
  }

  private seed(state: RiskStateShape, tenantId: string): void {
    if (state.rules.some((item) => item.tenantId === tenantId && item.builtin)) return;
    const nowIso = new Date(this.now()).toISOString();
    for (const rule of BUILTIN_RULES) {
      state.rules.push({
        id: `risk-rule-${tenantId}-${rule.code.toLowerCase()}`,
        tenantId,
        code: rule.code,
        description: rule.description,
        level: rule.level,
        pattern: rule.pattern,
        appliesToCapabilityIds: rule.capabilities ?? [],
        builtin: true,
        enabled: true,
        createdAt: nowIso,
      });
    }
  }
}

function zoneFor(level: RiskLevel, declared: CapabilityRisk): 0 | 1 | 2 | 3 | 4 {
  if (level === "critical") return 4;
  if (level === "high") return declared === "external_side_effect" ? 3 : 3;
  if (level === "medium") return declared === "workspace_write" ? 1 : 2;
  return declared === "pure" || declared === "workspace_read" ? 0 : 1;
}

const patternCache = new Map<string, RegExp>();
function compilePattern(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  if (pattern.length > 2000) throw new Error("Risk rule pattern is too long.");
  const expression = new RegExp(pattern, "i");
  patternCache.set(pattern, expression);
  return expression;
}

/** Flattens capability arguments into one lowercase string for pattern matching, with a hard bound. */
function flattenArguments(args: unknown, depth = 0): string {
  if (depth > 6 || args === null || args === undefined) return "";
  if (typeof args === "string") return args.slice(0, 20_000);
  if (typeof args === "number" || typeof args === "boolean") return String(args);
  if (Array.isArray(args)) return args.slice(0, 200).map((item) => flattenArguments(item, depth + 1)).join(" \n ").slice(0, 40_000);
  if (typeof args === "object") {
    return Object.entries(args as Record<string, unknown>)
      .slice(0, 200)
      .map(([key, value]) => `${key} ${flattenArguments(value, depth + 1)}`)
      .join(" \n ")
      .slice(0, 40_000);
  }
  return "";
}
