import { randomUUID } from "node:crypto";
import { auroraInteger, auroraText } from "../util/aurora-state.js";

const MAX_PENDING_PER_SESSION = 3;
const MAX_OPTIONS = 6;
const MIN_OPTIONS = 2;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface UserQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserQuestion {
  id: string;
  tenantId: string;
  sessionId: string;
  question: string;
  context?: string;
  options: UserQuestionOption[];
  allowFreeText: boolean;
  askedAt: string;
  expiresAt: string;
  status: "pending" | "answered" | "cancelled" | "timed-out";
  answer?: { optionId?: string; text?: string; answeredAt: string; answeredBy: string };
}

export type UserQuestionListener = (question: UserQuestion) => void;

/**
 * Structured questions to the human.
 *
 * Aurora could always ask for *approval* of an action it had already chosen. What it could not do is
 * ask "which of these three?" — so an uncertain agent had two bad options: guess, or stop and hope
 * somebody reads the transcript. Peers made this a first-class tool, and the semantics that matter are
 * the refusals:
 *
 * - a question is **bounded**: two to six options, bounded lengths, a hard expiry, and at most a few
 *   outstanding per session, so an agent cannot bury a human under prompts;
 * - a timeout returns `timedOut`, never a default answer. Inventing "the user probably meant option A"
 *   is exactly how an agent ends up doing something nobody asked for;
 * - free text is opt-in per question, so a question that must be one of N stays one of N;
 * - answers are attributed and timestamped, because "who told it to do that?" has to be answerable.
 *
 * The service holds no policy of its own: `dontAsk` denies the capability at the mode layer, which is
 * where that decision belongs.
 */
export class UserQuestionService {
  private readonly questions = new Map<string, UserQuestion>();
  private readonly waiters = new Map<string, { resolve: (value: UserQuestion) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<UserQuestionListener>();

  constructor(private readonly now: () => number = Date.now) {}

  subscribe(listener: UserQuestionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Ask, and wait. Resolves when a human answers, the question is cancelled, or the timeout expires. */
  async ask(input: {
    tenantId: string; sessionId: string; question: string; context?: string;
    options: Array<{ label: string; description?: string | undefined }>; allowFreeText?: boolean; timeoutMs?: number;
  }): Promise<UserQuestion> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const sessionId = auroraText(input.sessionId, 200, "Session ID");
    if (input.options.length < MIN_OPTIONS || input.options.length > MAX_OPTIONS) {
      throw new Error(`A question needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options; a single option is not a question.`);
    }
    const outstanding = [...this.questions.values()].filter((item) => item.sessionId === sessionId && item.status === "pending");
    if (outstanding.length >= MAX_PENDING_PER_SESSION) {
      throw new Error(`This session already has ${outstanding.length} unanswered question(s); answer one before asking another.`);
    }
    const timeoutMs = auroraInteger(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 5_000, 30 * 60_000, "Question timeout");
    const askedAt = this.now();
    const question: UserQuestion = {
      id: `question-${randomUUID()}`,
      tenantId,
      sessionId,
      question: auroraText(input.question, 2000, "Question"),
      ...(input.context ? { context: auroraText(input.context, 10_000, "Question context") } : {}),
      options: input.options.map((option, index) => ({
        id: `option-${index + 1}`,
        label: auroraText(option.label, 200, "Option label"),
        ...(option.description ? { description: auroraText(option.description, 1000, "Option description") } : {}),
      })),
      allowFreeText: input.allowFreeText ?? false,
      askedAt: new Date(askedAt).toISOString(),
      expiresAt: new Date(askedAt + timeoutMs).toISOString(),
      status: "pending",
    };
    this.questions.set(question.id, question);
    this.emit(question);

    return await new Promise<UserQuestion>((resolveQuestion) => {
      const timer = setTimeout(() => {
        const current = this.questions.get(question.id);
        if (current && current.status === "pending") {
          current.status = "timed-out";
          this.emit(current);
        }
        this.waiters.delete(question.id);
        resolveQuestion(structuredClone(this.questions.get(question.id) ?? question));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(question.id, { resolve: resolveQuestion, timer });
    });
  }

  answer(input: { questionId: string; optionId?: string; text?: string; answeredBy?: string }): UserQuestion {
    const question = this.questions.get(input.questionId);
    if (!question) throw new Error("Question not found.");
    if (question.status !== "pending") throw new Error(`Question is already ${question.status}.`);
    if (!input.optionId && !input.text) throw new Error("An answer needs an option or, when allowed, free text.");
    if (input.optionId && !question.options.some((item) => item.id === input.optionId)) throw new Error("Unknown option for this question.");
    if (input.text && !question.allowFreeText) throw new Error("This question does not accept free text.");

    question.status = "answered";
    question.answer = {
      ...(input.optionId ? { optionId: input.optionId } : {}),
      ...(input.text ? { text: auroraText(input.text, 5000, "Answer text") } : {}),
      answeredAt: new Date(this.now()).toISOString(),
      answeredBy: auroraText(input.answeredBy ?? "operator", 200, "Answered by"),
    };
    this.settle(question);
    return structuredClone(question);
  }

  cancel(questionId: string, reason = "cancelled"): UserQuestion {
    const question = this.questions.get(questionId);
    if (!question) throw new Error("Question not found.");
    if (question.status === "pending") {
      question.status = "cancelled";
      question.answer = { text: auroraText(reason, 500, "Cancel reason"), answeredAt: new Date(this.now()).toISOString(), answeredBy: "system" };
      this.settle(question);
    }
    return structuredClone(question);
  }

  /** Cancel everything outstanding for a session, e.g. when it closes. */
  cancelForSession(sessionId: string, reason = "session closed"): number {
    let cancelled = 0;
    for (const question of this.questions.values()) {
      if (question.sessionId === sessionId && question.status === "pending") {
        this.cancel(question.id, reason);
        cancelled++;
      }
    }
    return cancelled;
  }

  list(filter: { tenantId?: string; sessionId?: string; pendingOnly?: boolean; limit?: number } = {}): UserQuestion[] {
    return [...this.questions.values()]
      .filter((item) => (filter.tenantId ? item.tenantId === filter.tenantId : true))
      .filter((item) => (filter.sessionId ? item.sessionId === filter.sessionId : true))
      .filter((item) => (filter.pendingOnly ? item.status === "pending" : true))
      .sort((a, b) => b.askedAt.localeCompare(a.askedAt))
      .slice(0, auroraInteger(filter.limit ?? 50, 1, 500, "Question limit"))
      .map((item) => structuredClone(item));
  }

  get(questionId: string): UserQuestion | undefined {
    const found = this.questions.get(questionId);
    return found ? structuredClone(found) : undefined;
  }

  private settle(question: UserQuestion): void {
    const waiter = this.waiters.get(question.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(question.id);
      waiter.resolve(structuredClone(question));
    }
    this.emit(question);
  }

  private emit(question: UserQuestion): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(question));
      } catch {
        // A broken listener must never break the question flow.
      }
    }
  }
}
