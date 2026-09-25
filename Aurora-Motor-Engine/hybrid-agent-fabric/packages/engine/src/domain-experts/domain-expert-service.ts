/**
 * Domain Expert Service
 * Law, finance, health and other high-risk domain expert modes.
 * Source-showing, controlled expert assistant — NOT final decision maker.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

// ─── Types ───

export type DomainType = "legal" | "finance" | "health" | "tax" | "compliance" | "insurance" | "real_estate" | "employment" | "intellectual_property" | "immigration";

export interface DomainExpert {
  id: string;
  domain: DomainType;
  name: string;
  description: string;
  capabilities: string[];
  limitations: string[];
  disclaimers: string[];
  sourceRequirements: SourceRequirement[];
  riskLevel: "high" | "very_high" | "critical";
  active: boolean;
  createdAt: string;
}

export interface SourceRequirement {
  type: "statute" | "regulation" | "case_law" | "professional_standard" | "official_guidance";
  jurisdiction: string;
  required: boolean;
  description: string;
}

export interface ExpertConsultation {
  id: string;
  tenantId: string;
  expertId: string;
  domain: DomainType;
  query: string;
  response: ExpertResponse;
  createdAt: string;
}

export interface ExpertResponse {
  summary: string;
  analysis: string;
  sources: ExpertSource[];
  recommendations: string[];
  disclaimers: string[];
  confidence: number; // 0-1
  riskAssessment: RiskAssessment;
  nextSteps: string[];
  requiresProfessionalReview: boolean;
}

export interface ExpertSource {
  id: string;
  type: "statute" | "regulation" | "case_law" | "official_guidance" | "professional_standard" | "academic";
  title: string;
  citation: string;
  url?: string;
  jurisdiction: string;
  relevance: number; // 0-1
  excerpt: string;
  verified: boolean;
}

export interface RiskAssessment {
  level: "low" | "medium" | "high" | "critical";
  factors: string[];
  mitigations: string[];
  consequences: string[];
}

export interface ComplianceCheck {
  id: string;
  tenantId: string;
  domain: DomainType;
  jurisdiction: string;
  requirements: ComplianceRequirement[];
  /**
   * `unknown` when no requirements are loaded for this domain/jurisdiction.
   *
   * It is distinct from `compliant`: one says the rules were checked and met,
   * the other says the rules are not known here. Collapsing the two would
   * report an absence of data as a clean bill of health.
   */
  status: "compliant" | "non_compliant" | "partial" | "unknown";
  /** 0-100. Zero when `status` is `unknown`: nothing was verified. */
  score: number;
  gaps: ComplianceGap[];
  checkedAt: string;
  /** Present only for `unknown`, explaining what is missing. */
  unknownReason?: string;
}

export interface ComplianceRequirement {
  id: string;
  description: string;
  source: string;
  mandatory: boolean;
  met: boolean;
  evidence?: string;
}

export interface ComplianceGap {
  requirementId: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  remediation: string;
  deadline?: string;
}

// ─── State ───

interface DomainExpertState {
  schemaVersion: number;
  experts: DomainExpert[];
  consultations: ExpertConsultation[];
  complianceChecks: ComplianceCheck[];
}

export class DomainExpertService {
  private store: DurableJsonState<DomainExpertState>;

  constructor(private baseDir: string) {
    this.store = new DurableJsonState<DomainExpertState>(
      join(baseDir, "domain-experts.json"),
      () => ({ schemaVersion: 1, experts: this.createDefaultExperts(), consultations: [], complianceChecks: [] }),
      (v) => { const s = v as DomainExpertState; return !!s && s.schemaVersion === 1; },
      "Domain expert service",
    );
  }

  async init(): Promise<void> { await this.store.read(); }

  // ─── Default Experts ───

  private createDefaultExperts(): DomainExpert[] {
    return [
      {
        id: "expert-legal",
        domain: "legal",
        name: "Hukuk Danışmanı",
        description: "Hukuki konularda kaynak gösteren yardımcı mod. Nihai karar vermez, profesyonel hukuki tavsiye yerine geçmez.",
        capabilities: [
          "Mevzuat araştırması",
          "Sözleşme analizi",
          "Uyumluluk kontrolü",
          "Risk değerlendirmesi",
          "Kaynak gösterme",
        ],
        limitations: [
          "Nihai hukuki tavsiye veremez",
          "Baro kayıtlı avukat değildir",
          "Dava stratejisi belirleyemez",
          "Mahkeme temsil edemez",
        ],
        disclaimers: [
          "Bu analiz bilgilendirme amaçlıdır, hukuki tavsiye niteliği taşımaz.",
          "Önemli kararlar için mutlaka bir avukata danışınız.",
          "Mevzuat değişiklikleri güncel olmayabilir.",
        ],
        sourceRequirements: [
          { type: "statute", jurisdiction: "TR", required: true, description: "İlgili kanun maddeleri" },
          { type: "regulation", jurisdiction: "TR", required: false, description: "Yönetmelikler ve tebliğler" },
          { type: "case_law", jurisdiction: "TR", required: false, description: "İçtihat kararları" },
        ],
        riskLevel: "very_high",
        active: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: "expert-finance",
        domain: "finance",
        name: "Finans Danışmanı",
        description: "Finansal konularda kaynak gösteren yardımcı mod. Yatırım tavsiyesi vermez.",
        capabilities: [
          "Finansal analiz",
          "Bütçe planlama",
          "Vergi hesaplama",
          "Finansal tablo okuma",
          "Kaynak gösterme",
        ],
        limitations: [
          "Yatırım tavsiyesi veremez",
          "SPK lisanslı değildir",
          "Portföy yönetimi yapamaz",
          "Garanti getiri belirleyemez",
        ],
        disclaimers: [
          "Bu analiz bilgilendirme amaçlıdır, yatırım tavsiyesi niteliği taşımaz.",
          "Yatırım kararları için lisanslı bir finansal danışmana başvurunuz.",
          "Geçmiş performans gelecek getiri garantisi değildir.",
        ],
        sourceRequirements: [
          { type: "official_guidance", jurisdiction: "TR", required: true, description: "SPK, BDDK düzenlemeleri" },
          { type: "professional_standard", jurisdiction: "TR", required: false, description: "TMS/TFRS standartları" },
        ],
        riskLevel: "high",
        active: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: "expert-health",
        domain: "health",
        name: "Sağlık Bilgilendirme Asistanı",
        description: "Sağlık konularında genel bilgi sağlayan yardımcı mod. Tıbbi tavsiye vermez.",
        capabilities: [
          "Genel sağlık bilgilendirmesi",
          "Tıbbi terim açıklama",
          "Kaynak gösterme",
          "Semptom bilgilendirmesi",
        ],
        limitations: [
          "Tanı koyamaz",
          "Reçete yazamaz",
          "Tedavi öneremez",
          "Acil durum müdahalesi yapamaz",
        ],
        disclaimers: [
          "Bu bilgilendirme tıbbi tavsiye niteliği taşımaz.",
          "Sağlık sorunlarınız için mutlaka bir sağlık profesyoneline başvurunuz.",
          "Acil durumlarda112'yi arayınız.",
        ],
        sourceRequirements: [
          { type: "professional_standard", jurisdiction: "TR", required: true, description: "Sağlık Bakanlığı rehberleri" },
          { type: "professional_standard", jurisdiction: "TR", required: false, description: "PubMed, tıp dergileri" },
        ],
        riskLevel: "critical",
        active: true,
        createdAt: new Date().toISOString(),
      },
    ];
  }

  // ─── Expert Management ───

  async getExperts(domain?: DomainType): Promise<DomainExpert[]> {
    const s = await this.store.read();
    return s.experts.filter(e => e.active && (!domain || e.domain === domain));
  }

  async getExpert(id: string): Promise<DomainExpert | undefined> {
    const s = await this.store.read();
    return s.experts.find(e => e.id === id);
  }

  // ─── Consultation ───

  async consult(tenantId: string, domain: DomainType, query: string): Promise<ExpertConsultation> {
    const s = await this.store.read();
    const expert = s.experts.find(e => e.domain === domain && e.active);
    if (!expert) throw new Error(`No active expert for domain: ${domain}`);

    const sources = await this.findSources(domain, query);
    const response: ExpertResponse = {
      summary: `${expert.name} değerlendirmesi`,
      analysis: await this.analyze(domain, query, sources),
      sources,
      recommendations: await this.generateRecommendations(domain, query, sources),
      disclaimers: expert.disclaimers,
      confidence: this.calculateConfidence(sources),
      riskAssessment: await this.assessRisk(domain, query),
      nextSteps: await this.suggestNextSteps(domain, query),
      requiresProfessionalReview: expert.riskLevel === "critical" || expert.riskLevel === "very_high",
    };

    const consultation: ExpertConsultation = {
      id: randomUUID(),
      tenantId,
      expertId: expert.id,
      domain,
      query,
      response,
      createdAt: new Date().toISOString(),
    };

    await this.store.mutate(s => { s.consultations.push(consultation); });
    return consultation;
  }

  async getConsultations(tenantId: string, domain?: DomainType): Promise<ExpertConsultation[]> {
    const s = await this.store.read();
    return s.consultations.filter(c => c.tenantId === tenantId && (!domain || c.domain === domain));
  }

  // ─── Compliance Check ───

  async checkCompliance(tenantId: string, domain: DomainType, jurisdiction: string): Promise<ComplianceCheck> {
    const requirements = await this.getRequirements(domain, jurisdiction);
    const gaps: ComplianceGap[] = [];

    // An empty requirement list means nothing is known about this jurisdiction,
    // not that everything passed. The previous expression scored that 100 and
    // labelled it `compliant`, because `[].every(...)` is true — so an HTTP
    // caller asking about legal compliance in a jurisdiction with no loaded
    // rules was told it was fully compliant. For a high-risk domain that is the
    // most dangerous answer this service could give.
    //
    // `unknown` already existed in the status union and had no producer. This
    // is it.
    const known = requirements.length > 0;
    const met = requirements.filter((r) => r.met).length;

    const check: ComplianceCheck = {
      id: randomUUID(),
      tenantId,
      domain,
      jurisdiction,
      requirements,
      status: !known
        ? "unknown"
        : met === requirements.length
          ? "compliant"
          : met > 0
            ? "partial"
            : "non_compliant",
      // Zero, not 100: no evidence of compliance was gathered. The score is a
      // measurement, and an unmeasured thing does not score full marks.
      score: known ? (met / requirements.length) * 100 : 0,
      gaps,
      checkedAt: new Date().toISOString(),
      ...(known
        ? {}
        : {
            unknownReason:
              `No compliance requirements are loaded for domain '${domain}' in jurisdiction ` +
              `'${jurisdiction}'. This is an absence of data, not a finding of compliance. ` +
              `Consult a qualified professional for this jurisdiction.`,
          }),
    };

    await this.store.mutate(s => { s.complianceChecks.push(check); });
    return check;
  }

  // ─── Private Helpers ───

  private async findSources(domain: DomainType, query: string): Promise<ExpertSource[]> {
    // In production, search legal/financial/medical databases
    return [];
  }

  private async analyze(domain: DomainType, query: string, sources: ExpertSource[]): Promise<string> {
    return `${domain} alanında analiz: "${query}"`;
  }

  private async generateRecommendations(domain: DomainType, query: string, sources: ExpertSource[]): Promise<string[]> {
    return ["Profyonel danışman görüşü alınız."];
  }

  private calculateConfidence(sources: ExpertSource[]): number {
    if (sources.length === 0) return 0.2;
    return Math.min(0.8, sources.reduce((s, src) => s + src.relevance, 0) / sources.length);
  }

  private async assessRisk(domain: DomainType, query: string): Promise<RiskAssessment> {
    return {
      level: "high",
      factors: ["Yüksek riskli alan"],
      mitigations: ["Profyonel danışmanlık alın"],
      consequences: ["Yanlış bilgi ciddi sonuçlar doğurabilir"],
    };
  }

  private async suggestNextSteps(domain: DomainType, query: string): Promise<string[]> {
    return [
      "Profyonel bir danışmana başvurun",
      "İlgili kaynakları doğrulayın",
      "Güncel mevzuatı kontrol edin",
    ];
  }

  private async getRequirements(domain: DomainType, jurisdiction: string): Promise<ComplianceRequirement[]> {
    return [];
  }
}
