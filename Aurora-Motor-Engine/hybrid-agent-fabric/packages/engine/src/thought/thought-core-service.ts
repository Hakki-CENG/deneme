import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  auroraDigest, auroraIds, auroraInteger, auroraRound, auroraTags, auroraText,
  auroraTimestamp, auroraUnit, DurableJsonState,
} from "../util/aurora-state.js";

const MAX_THOUGHTS = 100_000;
const MAX_HYPOTHESES = 50_000;
const MAX_JOURNAL_ENTRIES = 20_000;
const MAX_OPEN_PROBLEMS = 5_000;
const MAX_RESEARCH_QUEUE = 10_000;
const MAX_SELF_DIALOGUES = 5_000;

export type ThoughtState = "new" | "active" | "researching" | "waiting" | "blocked" | "archived" | "solved";
export type ThoughtPriority = "P0" | "P1" | "P2" | "P3" | "P4";
export type ThoughtType = "problem" | "hypothesis" | "insight" | "question" | "opportunity" | "risk" | "decision";

export interface ThoughtObject {
  id: string;
  tenantId: string;
  title: string;
  content: string;
  type: ThoughtType;
  state: ThoughtState;
  priority: ThoughtPriority;
  importance: number;
  urgency: number;
  impact: number;
  confidence: number;
  userRelevance: number;
  priorityScore: number;
  sourceType: "user" | "agent" | "event" | "memory" | "system";
  sourceId?: string;
  relatedThoughtIds: string[];
  relatedMemoryIds: string[];
  relatedWorldModelIds: string[];
  evidenceRefs: string[];
  hypothesisRefs: string[];
  createdAt: string;
  updatedAt: string;
  lastActivatedAt?: string;
  activationCount: number;
  tags: string[];
}

export interface Hypothesis {
  id: string;
  tenantId: string;
  statement: string;
  thoughtId: string;
  /** P2.12: the open problem this hypothesis is linked to, when there is one. */
  problemId?: string;
  confidence: number;
  testability: number;
  status: "new" | "testing" | "confirmed" | "refuted" | "inconclusive";
  evidenceFor: string[];
  evidenceAgainst: string[];
  testPlan?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenProblem {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  category: string;
  status: "open" | "investigating" | "blocked" | "resolved" | "abandoned";
  priority: ThoughtPriority;
  importance: number;
  createdAt: string;
  updatedAt: string;
  lastReviewedAt?: string;
  findings: Array<{ summary: string; confidence: number; evidenceRefs: string[]; recordedAt: string }>;
  nextStep?: string;
  reviewIntervalDays: number;
}

export interface ResearchQueueItem {
  id: string;
  tenantId: string;
  title: string;
  topic: string;
  priority: ThoughtPriority;
  importance: number;
  status: "queued" | "in-progress" | "completed" | "cancelled";
  sourceType: "memory" | "world-model" | "git" | "calendar" | "filesystem" | "weather" | "research" | "system";
  sourceRef?: string;
  createdAt: string;
  updatedAt: string;
  assignedAgentId?: string;
  completionNotes?: string;
}

export interface SelfDialogue {
  id: string;
  tenantId: string;
  topic: string;
  participants: Array<{ agentId: string; role: string; statement: string; confidence: number; timestamp: string }>;
  status: "open" | "resolved" | "abandoned";
  conclusion?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThoughtJournalEntry {
  id: string;
  tenantId: string;
  timestamp: string;
  summary: string;
  detail: string;
  thoughtIds: string[];
  hypothesisIds: string[];
  tags: string[];
}

export interface ThoughtCoreMetrics {
  tenantId: string;
  totalThoughts: number;
  byState: Record<ThoughtState, number>;
  byType: Record<ThoughtType, number>;
  byPriority: Record<ThoughtPriority, number>;
  activeThoughts: number;
  blockedThoughts: number;
  solvedThoughts: number;
  openProblems: number;
  researchQueueSize: number;
  hypothesesCount: number;
  journalEntries: number;
  selfDialogues: number;
  generatedAt: string;
}

interface ThoughtCoreStateShape {
  schemaVersion: 1;
  thoughts: ThoughtObject[];
  hypotheses: Hypothesis[];
  openProblems: OpenProblem[];
  researchQueue: ResearchQueueItem[];
  selfDialogues: SelfDialogue[];
  journal: ThoughtJournalEntry[];
}

const PRIORITY_ORDER: ThoughtPriority[] = ["P0", "P1", "P2", "P3", "P4"];
const PRIORITY_WEIGHTS: Record<ThoughtPriority, number> = { P0: 1.0, P1: 0.8, P2: 0.6, P3: 0.4, P4: 0.2 };

/**
 * Aurora Thought Core - Merkezi düşünce motoru.
 * Tüm bilişsel süreçlerin koordinasyonunu sağlar.
 * 
 * Görevleri:
 * - Açık problemleri takip etmek
 * - Hipotez üretmek
 * - Bağlantı kurmak
 * - Çelişki bulmak
 * - Yeni araştırma başlatmak
 */
export class ThoughtCoreService {
  private readonly store: DurableJsonState<ThoughtCoreStateShape>;

  constructor(
    rootPath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new DurableJsonState<ThoughtCoreStateShape>(
      join(rootPath, "thought", "core", "state.json"),
      () => ({ schemaVersion: 1, thoughts: [], hypotheses: [], openProblems: [], researchQueue: [], selfDialogues: [], journal: [] }),
      (value) => {
        const state = value as ThoughtCoreStateShape;
        return !!state && state.schemaVersion === 1
          && Array.isArray(state.thoughts)
          && Array.isArray(state.hypotheses)
          && Array.isArray(state.openProblems)
          && Array.isArray(state.researchQueue)
          && Array.isArray(state.selfDialogues)
          && Array.isArray(state.journal);
      },
      "Aurora Thought Core",
    );
  }

  /**
   * Initialize the thought core service.
   */
  async initialize(): Promise<void> {
    // Ensure the store is loaded
    await this.store.read();
  }

  /**
   * Close the thought core service.
   */
  async close(): Promise<void> {
    // Clean up any resources
    // In a real implementation, this would close file handles, etc.
  }

  /**
   * Yeni bir düşünce nesnesi oluştur.
   * Thought Objects: NEW, ACTIVE, RESEARCHING, WAITING, BLOCKED, ARCHIVED, SOLVED
   */
  async createThought(input: {
    tenantId: string;
    title: string;
    content: string;
    type: ThoughtType;
    priority?: ThoughtPriority;
    importance?: number;
    urgency?: number;
    impact?: number;
    confidence?: number;
    userRelevance?: number;
    sourceType: ThoughtObject["sourceType"];
    sourceId?: string;
    relatedThoughtIds?: string[];
    relatedMemoryIds?: string[];
    relatedWorldModelIds?: string[];
    evidenceRefs?: string[];
    tags?: string[];
  }): Promise<ThoughtObject> {
    return await this.store.mutate((state) => {
      if (state.thoughts.length >= MAX_THOUGHTS) {
        throw new Error("Thought limit reached.");
      }

      const importance = auroraUnit(input.importance ?? 0.5, "Thought importance");
      const urgency = auroraUnit(input.urgency ?? 0.5, "Thought urgency");
      const impact = auroraUnit(input.impact ?? 0.5, "Thought impact");
      const confidence = auroraUnit(input.confidence ?? 0.5, "Thought confidence");
      const userRelevance = auroraUnit(input.userRelevance ?? 0.5, "Thought user relevance");
      const priority = input.priority ?? this.calculatePriority(importance, urgency, impact, confidence, userRelevance);

      const priorityScore = this.calculatePriorityScore(importance, urgency, impact, confidence, userRelevance, priority);

      const thought: ThoughtObject = {
        id: `thought-${randomUUID()}`,
        tenantId: input.tenantId,
        title: auroraText(input.title, 500, "Thought title"),
        content: auroraText(input.content, 50_000, "Thought content"),
        type: input.type,
        state: "new",
        priority,
        importance,
        urgency,
        impact,
        confidence,
        userRelevance,
        priorityScore,
        sourceType: input.sourceType,
        ...(input.sourceId ? { sourceId: auroraText(input.sourceId, 300, "Thought source ID") } : {}),
        relatedThoughtIds: auroraIds(input.relatedThoughtIds, 100, "Related thought IDs"),
        relatedMemoryIds: auroraIds(input.relatedMemoryIds, 100, "Related memory IDs"),
        relatedWorldModelIds: auroraIds(input.relatedWorldModelIds, 100, "Related world model IDs"),
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "Evidence refs"),
        hypothesisRefs: [],
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
        activationCount: 0,
        tags: auroraTags(input.tags),
      };

      state.thoughts.push(thought);
      return structuredClone(thought);
    });
  }

  /**
   * Düşünce durumunu güncelle.
   */
  async setThoughtState(tenantId: string, thoughtId: string, state: ThoughtState): Promise<ThoughtObject> {
    return await this.store.mutate((stateData) => {
      const thought = this.findThought(stateData, tenantId, thoughtId);
      const previousState = thought.state;
      thought.state = state;
      thought.updatedAt = new Date(this.now()).toISOString();

      // If activating from waiting/blocked, increment activation count
      if (previousState === "waiting" || previousState === "blocked") {
        thought.activationCount++;
        thought.lastActivatedAt = thought.updatedAt;
      }

      return structuredClone(thought);
    });
  }

  /**
   * Düşünceyi etkinleştir (active hale getir).
   */
  async activateThought(tenantId: string, thoughtId: string): Promise<ThoughtObject> {
    return this.setThoughtState(tenantId, thoughtId, "active");
  }

  /**
   * Düşünceyi araştırma moduna al.
   */
  async startResearching(tenantId: string, thoughtId: string): Promise<ThoughtObject> {
    return this.setThoughtState(tenantId, thoughtId, "researching");
  }

  /**
   * Düşünceyi bekleme moduna al.
   */
  async setWaiting(tenantId: string, thoughtId: string): Promise<ThoughtObject> {
    return this.setThoughtState(tenantId, thoughtId, "waiting");
  }

  /**
   * Düşünceyi bloke et.
   */
  async blockThought(tenantId: string, thoughtId: string, reason?: string): Promise<ThoughtObject> {
    return await this.store.mutate((stateData) => {
      const thought = this.findThought(stateData, tenantId, thoughtId);
      thought.state = "blocked";
      thought.updatedAt = new Date(this.now()).toISOString();
      
      // Add reason as a tag if provided.
      //
      // The slug has to be normalized at BOTH ends, not just internally. Without
      // the trim, "needs review" produced `blocked:needs-review` while
      // "needs review!" produced `blocked:needs-review-` — two distinct tags for
      // one reason, which silently defeated the deduplication below.
      if (reason) {
        const slug = auroraText(reason, 100, "Block reason")
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^[.-]+|[.-]+$/g, "");
        // A reason of nothing but punctuation slugifies to empty and would add a
        // bare `blocked:` tag carrying no information; skip it instead.
        if (slug) {
          const reasonTag = `blocked:${slug}`;
          if (!thought.tags.includes(reasonTag) && thought.tags.length < 100) {
            thought.tags.push(reasonTag);
          }
        }
      }
      
      return structuredClone(thought);
    });
  }

  /**
   * Düşünceyi arşivle.
   */
  async archiveThought(tenantId: string, thoughtId: string): Promise<ThoughtObject> {
    return this.setThoughtState(tenantId, thoughtId, "archived");
  }

  /**
   * Düşünceyi çözülmüş olarak işaretle.
   */
  async solveThought(tenantId: string, thoughtId: string, solution?: string): Promise<ThoughtObject> {
    return await this.store.mutate((stateData) => {
      const thought = this.findThought(stateData, tenantId, thoughtId);
      thought.state = "solved";
      thought.updatedAt = new Date(this.now()).toISOString();
      
      if (solution) {
        thought.content = `${thought.content}\n\n[SOLUTION] ${auroraText(solution, 20_000, "Solution")}`;
      }
      
      return structuredClone(thought);
    });
  }

  /**
   * Hipotez oluştur.
   */
  async createHypothesis(input: {
    tenantId: string;
    statement: string;
    thoughtId: string;
    problemId?: string;
    confidence?: number;
    testability?: number;
    testPlan?: string;
    evidenceFor?: string[];
    evidenceAgainst?: string[];
  }): Promise<Hypothesis> {
    return await this.store.mutate((state) => {
      if (state.hypotheses.length >= MAX_HYPOTHESES) {
        throw new Error("Hypothesis limit reached.");
      }
      // P2.12: a hypothesis may link to an open problem; a bad link is
      // rejected rather than silently dropped.
      if (input.problemId && !state.openProblems.some((item) => item.tenantId === input.tenantId && item.id === input.problemId)) {
        throw new Error(`Open problem not found: ${input.problemId}`);
      }

      const hypothesis: Hypothesis = {
        id: `hyp-${randomUUID()}`,
        tenantId: input.tenantId,
        statement: auroraText(input.statement, 2000, "Hypothesis statement"),
        thoughtId: input.thoughtId,
        ...(input.problemId ? { problemId: input.problemId } : {}),
        confidence: auroraUnit(input.confidence ?? 0.5, "Hypothesis confidence"),
        testability: auroraUnit(input.testability ?? 0.5, "Hypothesis testability"),
        status: "new",
        evidenceFor: auroraIds(input.evidenceFor, 200, "Evidence for"),
        evidenceAgainst: auroraIds(input.evidenceAgainst, 200, "Evidence against"),
        ...(input.testPlan ? { testPlan: auroraText(input.testPlan, 5000, "Test plan") } : {}),
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
      };

      state.hypotheses.push(hypothesis);
      
      // Link hypothesis to thought
      const thought = this.findThought(state, input.tenantId, input.thoughtId);
      if (!thought.hypothesisRefs.includes(hypothesis.id)) {
        thought.hypothesisRefs.push(hypothesis.id);
        thought.updatedAt = hypothesis.createdAt;
      }

      return structuredClone(hypothesis);
    });
  }

  /**
   * Hipotez durumunu güncelle (testing, confirmed, refuted, etc.).
   */
  async updateHypothesisStatus(
    tenantId: string,
    hypothesisId: string,
    status: Hypothesis["status"],
    evidenceFor?: string[],
    evidenceAgainst?: string[],
    testPlan?: string
  ): Promise<Hypothesis> {
    return await this.store.mutate((state) => {
      const hypothesis = state.hypotheses.find(
        (h) => h.tenantId === tenantId && h.id === hypothesisId
      );
      if (!hypothesis) {
        throw new Error("Hypothesis not found.");
      }

      hypothesis.status = status;
      hypothesis.updatedAt = new Date(this.now()).toISOString();

      if (evidenceFor) {
        hypothesis.evidenceFor = [...new Set([...hypothesis.evidenceFor, ...auroraIds(evidenceFor, 200, "Evidence for")])];
      }
      if (evidenceAgainst) {
        hypothesis.evidenceAgainst = [...new Set([...hypothesis.evidenceAgainst, ...auroraIds(evidenceAgainst, 200, "Evidence against")])];
      }
      if (testPlan) {
        hypothesis.testPlan = auroraText(testPlan, 5000, "Test plan");
      }

      // Update confidence based on evidence
      if (status === "confirmed") {
        hypothesis.confidence = Math.min(1, hypothesis.confidence + 0.2);
      } else if (status === "refuted") {
        hypothesis.confidence = Math.max(0, hypothesis.confidence - 0.3);
      }

      return structuredClone(hypothesis);
    });
  }

  /**
   * Açık problem oluştur.
   */
  async createOpenProblem(input: {
    tenantId: string;
    title: string;
    description: string;
    category: string;
    priority?: ThoughtPriority;
    importance?: number;
    reviewIntervalDays?: number;
    nextStep?: string;
  }): Promise<OpenProblem> {
    return await this.store.mutate((state) => {
      if (state.openProblems.length >= MAX_OPEN_PROBLEMS) {
        throw new Error("Open problem limit reached.");
      }

      const priority = input.priority ?? "P2";
      const importance = auroraUnit(input.importance ?? 0.7, "Problem importance");
      const reviewIntervalDays = auroraInteger(input.reviewIntervalDays ?? 7, 1, 365, "Review interval");

      const problem: OpenProblem = {
        id: `problem-${randomUUID()}`,
        tenantId: input.tenantId,
        title: auroraText(input.title, 300, "Problem title"),
        description: auroraText(input.description, 10_000, "Problem description"),
        category: auroraText(input.category, 100, "Problem category"),
        status: "open",
        priority,
        importance,
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
        reviewIntervalDays,
        ...(input.nextStep ? { nextStep: auroraText(input.nextStep, 1000, "Next step") } : {}),
        findings: [],
      };

      state.openProblems.push(problem);
      return structuredClone(problem);
    });
  }

  /**
   * Açık problem için bulgu ekle.
   */
  async addProblemFinding(input: {
    tenantId: string;
    problemId: string;
    summary: string;
    confidence: number;
    evidenceRefs?: string[];
  }): Promise<OpenProblem> {
    return await this.store.mutate((state) => {
      const problem = state.openProblems.find(
        (p) => p.tenantId === input.tenantId && p.id === input.problemId
      );
      if (!problem) {
        throw new Error("Open problem not found.");
      }

      problem.findings.push({
        summary: auroraText(input.summary, 2000, "Finding summary"),
        confidence: auroraUnit(input.confidence, "Finding confidence"),
        evidenceRefs: auroraIds(input.evidenceRefs, 200, "Evidence refs"),
        recordedAt: new Date(this.now()).toISOString(),
      });

      problem.updatedAt = new Date(this.now()).toISOString();
      problem.lastReviewedAt = problem.updatedAt;

      // Keep findings bounded
      if (problem.findings.length > 1000) {
        problem.findings.splice(0, problem.findings.length - 1000);
      }

      return structuredClone(problem);
    });
  }

  /**
   * Araştırma kuyruğuna öğe ekle.
   */
  async queueResearch(input: {
    tenantId: string;
    title: string;
    topic: string;
    priority?: ThoughtPriority;
    importance?: number;
    sourceType: ResearchQueueItem["sourceType"];
    sourceRef?: string;
  }): Promise<ResearchQueueItem> {
    return await this.store.mutate((state) => {
      if (state.researchQueue.length >= MAX_RESEARCH_QUEUE) {
        throw new Error("Research queue limit reached.");
      }

      const priority = input.priority ?? "P2";
      const importance = auroraUnit(input.importance ?? 0.6, "Research importance");

      const item: ResearchQueueItem = {
        id: `research-${randomUUID()}`,
        tenantId: input.tenantId,
        title: auroraText(input.title, 300, "Research title"),
        topic: auroraText(input.topic, 200, "Research topic"),
        priority,
        importance,
        status: "queued",
        sourceType: input.sourceType,
        ...(input.sourceRef ? { sourceRef: auroraText(input.sourceRef, 500, "Source ref") } : {}),
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
      };

      state.researchQueue.push(item);
      return structuredClone(item);
    });
  }

  /**
   * Araştırma kuyruğunu işle (en yüksek öncelikli öğeyi al).
   */
  async processResearchQueue(tenantId: string): Promise<ResearchQueueItem | null> {
    return await this.store.mutate((state) => {
      const queued = state.researchQueue
        .filter((item) => item.tenantId === tenantId && item.status === "queued")
        .sort((a, b) => {
          // Sort by priority first, then importance, then creation date
          const priorityDiff = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
          if (priorityDiff !== 0) return priorityDiff;
          const importanceDiff = b.importance - a.importance;
          if (importanceDiff !== 0) return importanceDiff;
          return a.createdAt.localeCompare(b.createdAt);
        })[0];

      if (!queued) return null;

      queued.status = "in-progress";
      queued.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(queued);
    });
  }

  /**
   * Araştırma öğesini tamamla.
   */
  async completeResearch(tenantId: string, itemId: string, notes?: string): Promise<ResearchQueueItem> {
    return await this.store.mutate((state) => {
      const item = state.researchQueue.find(
        (i) => i.tenantId === tenantId && i.id === itemId
      );
      if (!item) {
        throw new Error("Research queue item not found.");
      }

      item.status = "completed";
      item.updatedAt = new Date(this.now()).toISOString();
      if (notes) {
        item.completionNotes = auroraText(notes, 5000, "Completion notes");
      }

      return structuredClone(item);
    });
  }

  /**
   * İç diyalog başlat.
   */
  async startSelfDialogue(input: {
    tenantId: string;
    topic: string;
    initialStatement: string;
    initialAgentId: string;
    initialRole: string;
  }): Promise<SelfDialogue> {
    return await this.store.mutate((state) => {
      if (state.selfDialogues.length >= MAX_SELF_DIALOGUES) {
        throw new Error("Self dialogue limit reached.");
      }

      const dialogue: SelfDialogue = {
        id: `dialogue-${randomUUID()}`,
        tenantId: input.tenantId,
        topic: auroraText(input.topic, 300, "Dialogue topic"),
        participants: [
          {
            agentId: auroraText(input.initialAgentId, 200, "Agent ID"),
            role: auroraText(input.initialRole, 100, "Role"),
            statement: auroraText(input.initialStatement, 2000, "Statement"),
            confidence: 0.7,
            timestamp: new Date(this.now()).toISOString(),
          },
        ],
        status: "open",
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
      };

      state.selfDialogues.push(dialogue);
      return structuredClone(dialogue);
    });
  }

  /**
   * İç diyaloğa katılımcı ekle.
   */
  async addDialogueParticipant(input: {
    tenantId: string;
    dialogueId: string;
    agentId: string;
    role: string;
    statement: string;
    confidence?: number;
  }): Promise<SelfDialogue> {
    return await this.store.mutate((state) => {
      const dialogue = state.selfDialogues.find(
        (d) => d.tenantId === input.tenantId && d.id === input.dialogueId
      );
      if (!dialogue) {
        throw new Error("Self dialogue not found.");
      }

      dialogue.participants.push({
        agentId: auroraText(input.agentId, 200, "Agent ID"),
        role: auroraText(input.role, 100, "Role"),
        statement: auroraText(input.statement, 2000, "Statement"),
        confidence: auroraUnit(input.confidence ?? 0.7, "Confidence"),
        timestamp: new Date(this.now()).toISOString(),
      });

      dialogue.updatedAt = new Date(this.now()).toISOString();

      // Keep participants bounded
      if (dialogue.participants.length > 50) {
        dialogue.participants.splice(0, dialogue.participants.length - 50);
      }

      return structuredClone(dialogue);
    });
  }

  /**
   * İç diyaloğu sonlandır.
   */
  async resolveSelfDialogue(
    tenantId: string,
    dialogueId: string,
    conclusion: string
  ): Promise<SelfDialogue> {
    return await this.store.mutate((state) => {
      const dialogue = state.selfDialogues.find(
        (d) => d.tenantId === tenantId && d.id === dialogueId
      );
      if (!dialogue) {
        throw new Error("Self dialogue not found.");
      }

      dialogue.status = "resolved";
      dialogue.conclusion = auroraText(conclusion, 2000, "Conclusion");
      dialogue.updatedAt = new Date(this.now()).toISOString();

      return structuredClone(dialogue);
    });
  }

  /**
   * Düşünce günlüğüne giriş ekle.
   */
  async addJournalEntry(input: {
    tenantId: string;
    summary: string;
    detail: string;
    thoughtIds?: string[];
    hypothesisIds?: string[];
    tags?: string[];
  }): Promise<ThoughtJournalEntry> {
    return await this.store.mutate((state) => {
      if (state.journal.length >= MAX_JOURNAL_ENTRIES) {
        // Remove oldest entries
        state.journal.splice(0, state.journal.length - MAX_JOURNAL_ENTRIES + 100);
      }

      const entry: ThoughtJournalEntry = {
        id: `journal-${randomUUID()}`,
        tenantId: input.tenantId,
        timestamp: new Date(this.now()).toISOString(),
        summary: auroraText(input.summary, 500, "Journal summary"),
        detail: auroraText(input.detail, 10_000, "Journal detail"),
        thoughtIds: auroraIds(input.thoughtIds, 100, "Thought IDs"),
        hypothesisIds: auroraIds(input.hypothesisIds, 100, "Hypothesis IDs"),
        tags: auroraTags(input.tags),
      };

      state.journal.push(entry);
      return structuredClone(entry);
    });
  }

  /**
   * Düşünceleri listeler.
   */
  async listThoughts(
    tenantId: string,
    filter?: {
      state?: ThoughtState;
      type?: ThoughtType;
      priority?: ThoughtPriority;
      minImportance?: number;
      limit?: number;
    }
  ): Promise<ThoughtObject[]> {
    const state = await this.store.read();
    const limit = auroraInteger(filter?.limit ?? 100, 1, 1000, "Thought limit");
    const minImportance = filter?.minImportance === undefined ? 0 : auroraUnit(filter.minImportance, "Min importance");

    return state.thoughts
      .filter(
        (t) =>
          t.tenantId === tenantId &&
          (!filter?.state || t.state === filter.state) &&
          (!filter?.type || t.type === filter.type) &&
          (!filter?.priority || t.priority === filter.priority) &&
          t.importance >= minImportance
      )
      .sort((a, b) => b.priorityScore - a.priorityScore || b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((t) => structuredClone(t));
  }

  /**
   * Açık problemleri listeler.
   */
  async listOpenProblems(
    tenantId: string,
    filter?: { status?: OpenProblem["status"]; category?: string; limit?: number }
  ): Promise<OpenProblem[]> {
    const state = await this.store.read();
    const limit = auroraInteger(filter?.limit ?? 100, 1, 1000, "Problem limit");

    return state.openProblems
      .filter(
        (p) =>
          p.tenantId === tenantId &&
          (!filter?.status || p.status === filter.status) &&
          (!filter?.category || p.category === filter.category)
      )
      .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.importance - a.importance)
      .slice(0, limit)
      .map((p) => structuredClone(p));
  }

  /**
   * Araştırma kuyruğunu listeler.
   */
  async listResearchQueue(
    tenantId: string,
    filter?: { status?: ResearchQueueItem["status"]; limit?: number }
  ): Promise<ResearchQueueItem[]> {
    const state = await this.store.read();
    const limit = auroraInteger(filter?.limit ?? 100, 1, 1000, "Queue limit");

    return state.researchQueue
      .filter(
        (i) =>
          i.tenantId === tenantId &&
          (!filter?.status || i.status === filter.status)
      )
      .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.importance - a.importance)
      .slice(0, limit)
      .map((i) => structuredClone(i));
  }

  /**
   * Hipotezleri listeler.
   */
  async listHypotheses(
    tenantId: string,
    filter?: { status?: Hypothesis["status"]; minConfidence?: number; limit?: number }
  ): Promise<Hypothesis[]> {
    const state = await this.store.read();
    const limit = auroraInteger(filter?.limit ?? 100, 1, 1000, "Hypothesis limit");
    const minConfidence = filter?.minConfidence === undefined ? 0 : auroraUnit(filter.minConfidence, "Min confidence");

    return state.hypotheses
      .filter(
        (h) =>
          h.tenantId === tenantId &&
          (!filter?.status || h.status === filter.status) &&
          h.confidence >= minConfidence
      )
      .sort((a, b) => b.confidence - a.confidence || b.testability - a.testability)
      .slice(0, limit)
      .map((h) => structuredClone(h));
  }

  /**
   * P2.12: hypotheses linked to one open problem, newest evidence first.
   */
  async hypothesesForProblem(tenantId: string, problemId: string): Promise<Hypothesis[]> {
    const state = await this.store.read();
    return state.hypotheses
      .filter((h) => h.tenantId === tenantId && h.problemId === problemId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((h) => structuredClone(h));
  }

  /**
   * İç diyalogları listeler.
   */
  async listSelfDialogues(
    tenantId: string,
    filter?: { status?: SelfDialogue["status"]; limit?: number }
  ): Promise<SelfDialogue[]> {
    const state = await this.store.read();
    const limit = auroraInteger(filter?.limit ?? 100, 1, 1000, "Dialogue limit");

    return state.selfDialogues
      .filter(
        (d) =>
          d.tenantId === tenantId &&
          (!filter?.status || d.status === filter.status)
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((d) => structuredClone(d));
  }

  /**
   * Düşünce günlüğünü listeler.
   */
  async listJournal(
    tenantId: string,
    limit?: number
  ): Promise<ThoughtJournalEntry[]> {
    const state = await this.store.read();
    const l = auroraInteger(limit ?? 100, 1, 1000, "Journal limit");

    return state.journal
      .filter((e) => e.tenantId === tenantId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, l)
      .map((e) => structuredClone(e));
  }

  /**
   * Thought Core metriklerini getir.
   */
  async getMetrics(tenantId: string): Promise<ThoughtCoreMetrics> {
    const state = await this.store.read();

    const tenantThoughts = state.thoughts.filter((t) => t.tenantId === tenantId);
    const tenantHypotheses = state.hypotheses.filter((h) => h.tenantId === tenantId);
    const tenantProblems = state.openProblems.filter((p) => p.tenantId === tenantId);
    const tenantResearch = state.researchQueue.filter((r) => r.tenantId === tenantId);
    const tenantDialogues = state.selfDialogues.filter((d) => d.tenantId === tenantId);
    const tenantJournal = state.journal.filter((j) => j.tenantId === tenantId);

    const byState: Record<ThoughtState, number> = {
      new: 0,
      active: 0,
      researching: 0,
      waiting: 0,
      blocked: 0,
      archived: 0,
      solved: 0,
    };

    const byType: Record<ThoughtType, number> = {
      problem: 0,
      hypothesis: 0,
      insight: 0,
      question: 0,
      opportunity: 0,
      risk: 0,
      decision: 0,
    };

    const byPriority: Record<ThoughtPriority, number> = {
      P0: 0,
      P1: 0,
      P2: 0,
      P3: 0,
      P4: 0,
    };

    for (const thought of tenantThoughts) {
      byState[thought.state]++;
      byType[thought.type]++;
      byPriority[thought.priority]++;
    }

    return {
      tenantId,
      totalThoughts: tenantThoughts.length,
      byState,
      byType,
      byPriority,
      activeThoughts: byState.active + byState.researching,
      blockedThoughts: byState.blocked,
      solvedThoughts: byState.solved,
      openProblems: tenantProblems.length,
      researchQueueSize: tenantResearch.length,
      hypothesesCount: tenantHypotheses.length,
      journalEntries: tenantJournal.length,
      selfDialogues: tenantDialogues.length,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Arka planda düşünebilme sistemi.
   * Boşta kalan kaynakları kullanarak:
   * - Hafızayı tarar
   * - Açık problemleri inceler
   * - Eski fikirleri değerlendirir
   * - Yeni bağlantılar arar
   */
  async runBackgroundThinking(tenantId: string, options?: {
    maxThoughts?: number;
    maxDurationMs?: number;
  }): Promise<{
    thoughtsProcessed: number;
    newConnections: number;
    problemsReviewed: number;
    hypothesesGenerated: number;
    durationMs: number;
  }> {
    const startTime = this.now();
    const maxThoughts = auroraInteger(options?.maxThoughts ?? 50, 1, 200, "Max thoughts");
    const maxDurationMs = auroraInteger(options?.maxDurationMs ?? 5000, 100, 60000, "Max duration");

    let thoughtsProcessed = 0;
    let newConnections = 0;
    let problemsReviewed = 0;
    let hypothesesGenerated = 0;

    // 1. Get low-priority thoughts that haven't been activated recently
    const thoughts = await this.listThoughts(tenantId, {
      state: "waiting",
      limit: maxThoughts * 2,
    });

    // 2. Process thoughts for connections
    for (const thought of thoughts.slice(0, maxThoughts)) {
      if (this.now() - startTime > maxDurationMs) break;

      thoughtsProcessed++;

      // Try to find connections with other thoughts
      const related = await this.listThoughts(tenantId, {
        limit: 20,
      });

      // Simple connection logic: find thoughts with similar tags
      for (const other of related) {
        if (other.id === thought.id) continue;
        
        const commonTags = thought.tags.filter((tag) => other.tags.includes(tag));
        if (commonTags.length >= 2 && !thought.relatedThoughtIds.includes(other.id)) {
          // Add connection
          await this.store.mutate((state) => {
            const t = state.thoughts.find(
              (x) => x.tenantId === tenantId && x.id === thought.id
            );
            const o = state.thoughts.find(
              (x) => x.tenantId === tenantId && x.id === other.id
            );
            
            if (t && o) {
              if (!t.relatedThoughtIds.includes(other.id)) {
                t.relatedThoughtIds.push(other.id);
              }
              if (!o.relatedThoughtIds.includes(thought.id)) {
                o.relatedThoughtIds.push(thought.id);
              }
              newConnections++;
            }
          });
        }
      }

      // Check if we should generate a hypothesis.
      //
      // This used to be gated on `Math.random() < 0.1`, which made background
      // thinking non-reproducible: the same state could or could not produce a
      // hypothesis, so the behaviour could not be tested or explained. The rule
      // is now deterministic — an unresolved, low-confidence problem that has
      // accumulated related context and does not already have a hypothesis is
      // exactly the case worth forming one about.
      const currentState = await this.store.read();
      const alreadyHypothesised = currentState.hypotheses.some(
        (hypothesis) => hypothesis.tenantId === tenantId && hypothesis.thoughtId === thought.id,
      );
      // Re-read the thought: connections discovered above are not reflected in
      // the stale copy we are iterating over.
      const linked = currentState.thoughts.find(
        (item) => item.tenantId === tenantId && item.id === thought.id,
      );
      const hasContext = (linked ?? thought).relatedThoughtIds.length > 0;

      if (thought.type === "problem" && thought.confidence < 0.7 && hasContext && !alreadyHypothesised) {
        const hypothesisStatement = `Potential solution to: ${thought.title}`;
        try {
          await this.createHypothesis({
            tenantId,
            statement: hypothesisStatement,
            thoughtId: thought.id,
            confidence: 0.3,
            testability: 0.6,
          });
          hypothesesGenerated++;
        } catch {
          // Ignore errors
        }
      }

      // Mark as activated
      await this.activateThought(tenantId, thought.id);
    }

    // 3. Review open problems
    const problems = await this.listOpenProblems(tenantId, {
      status: "open",
      limit: 10,
    });

    for (const problem of problems) {
      if (this.now() - startTime > maxDurationMs) break;

      problemsReviewed++;

      // Check if problem should be reviewed
      if (problem.lastReviewedAt) {
        const lastReview = Date.parse(problem.lastReviewedAt);
        const daysSinceReview = (this.now() - lastReview) / 86_400_000;
        
        if (daysSinceReview >= problem.reviewIntervalDays) {
          // Add a review finding
          await this.addProblemFinding({
            tenantId,
            problemId: problem.id,
            summary: `Automated review: Problem still open after ${Math.round(daysSinceReview)} days`,
            confidence: 0.6,
          });
        }
      }
    }

    const durationMs = this.now() - startTime;

    return {
      thoughtsProcessed,
      newConnections,
      problemsReviewed,
      hypothesesGenerated,
      durationMs,
    };
  }

  /**
   * Düşünce çekirdeği sağlık raporu.
   */
  async healthCheck(tenantId: string): Promise<{
    healthy: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const metrics = await this.getMetrics(tenantId);
    const state = await this.store.read();
    const issues: string[] = [];
    const recommendations: string[] = [];

    // Check for too many blocked thoughts
    if (metrics.blockedThoughts > metrics.totalThoughts * 0.3) {
      issues.push(`High blocked thoughts ratio: ${metrics.blockedThoughts}/${metrics.totalThoughts}`);
      recommendations.push("Review blocked thoughts and resolve conflicts or remove them.");
    }

    // Check for too many waiting thoughts
    if (metrics.byState.waiting > metrics.totalThoughts * 0.5) {
      issues.push(`High waiting thoughts: ${metrics.byState.waiting}`);
      recommendations.push("Activate waiting thoughts or reduce attention budget.");
    }

    // Check for low confidence hypotheses
    const lowConfidenceHyp = state.hypotheses.filter(
      (h) => h.tenantId === tenantId && h.confidence < 0.3 && h.status === "new"
    );
    if (lowConfidenceHyp.length > 10) {
      issues.push(`Too many low-confidence hypotheses: ${lowConfidenceHyp.length}`);
      recommendations.push("Test or discard low-confidence hypotheses.");
    }

    // Check for old open problems
    const oldProblems = state.openProblems.filter(
      (p) => p.tenantId === tenantId && p.status === "open" &&
        (!p.lastReviewedAt || (this.now() - Date.parse(p.lastReviewedAt)) / 86_400_000 > p.reviewIntervalDays * 2)
    );
    if (oldProblems.length > 5) {
      issues.push(`Old open problems not reviewed: ${oldProblems.length}`);
      recommendations.push("Review and update old open problems.");
    }

    return {
      healthy: issues.length === 0,
      issues,
      recommendations,
    };
  }

  /**
   * Belirli bir düşünceyi bul.
   */
  private findThought(state: ThoughtCoreStateShape, tenantId: string, thoughtId: string): ThoughtObject {
    const thought = state.thoughts.find(
      (t) => t.tenantId === tenantId && t.id === thoughtId
    );
    if (!thought) {
      throw new Error(`Thought ${thoughtId} not found in tenant ${tenantId}.`);
    }
    return thought;
  }

  /**
   * Öncelik puanı hesapla.
   */
  private calculatePriority(
    importance: number,
    urgency: number,
    impact: number,
    confidence: number,
    userRelevance: number
  ): ThoughtPriority {
    const score = (importance + urgency + impact + confidence + userRelevance) / 5;
    
    if (score >= 0.8) return "P0";
    if (score >= 0.6) return "P1";
    if (score >= 0.4) return "P2";
    if (score >= 0.2) return "P3";
    return "P4";
  }

  /**
   * Öncelik skoru hesapla.
   */
  private calculatePriorityScore(
    importance: number,
    urgency: number,
    impact: number,
    confidence: number,
    userRelevance: number,
    priority: ThoughtPriority
  ): number {
    const priorityWeight = PRIORITY_WEIGHTS[priority];
    return Number(
      ((importance * 0.25 + urgency * 0.2 + impact * 0.2 + confidence * 0.15 + userRelevance * 0.2) * priorityWeight).toFixed(6)
    );
  }
}
