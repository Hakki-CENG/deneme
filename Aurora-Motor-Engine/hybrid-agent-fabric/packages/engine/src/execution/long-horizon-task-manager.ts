/**
 * B8 (P1.8): the long-horizon task manager.
 *
 * What existed before, measured: the `DurableScheduler` schedules *session
 * prompts* (cron/interval/once) and `AutomationService` persists command runs —
 * both durable, neither about *tasks*. A goal that takes hours or days had no
 * representation: `engine.execute()` is a synchronous promise, and a process
 * restart lost everything but the session logs. There was no pause, no waiting
 * state for a human decision, no escalation policy, no parent-child linkage,
 * and no progress digest — the eight things P1.8 lists, none of them present.
 *
 * The shape that makes all eight honest at once: **a long-horizon task is a
 * sequence of child tasks.** Each step is a real `execute()` call through the
 * full B1–B7 spine (identity, understanding, planning, walking, verification,
 * evidence), linked to its parent by the `parentTaskId` B1 added for exactly
 * this purpose. The manager owns the *between* — persistence, pausing,
 * scheduling, deadlines, approvals, escalation — and never the *within*, which
 * stays with the execution primitive it is handed.
 *
 * Durability is the AutomationService pattern: an atomically-written JSON
 * state file. A task found `running` on load is re-queued rather than trusted:
 * the process died mid-step, and a step that may have half-happened is re-run
 * under the same idempotency key the primitive already provides (A6).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWrite } from "../util/atomic-file.js";
import type { ExecutionStatus } from "./execution-status.js";
import type { TaskProvenance } from "./task-context.js";

/** What one step of a long-horizon task is: a goal, plus how it may run. */
export interface LongHorizonStepSpec {
  /** The goal handed to the execution primitive for this step. */
  readonly goal: string;
  /**
   * This step must not start until a human has approved it (P1.8). For
   * destructive or irreversible phases.
   */
  readonly requiresApproval?: boolean | undefined;
  /** Earliest instant this step may run (P1.8: scheduled continuation). */
  readonly scheduledFor?: string | undefined;
}

/** What happens when a step does not end `succeeded` (P1.8: failure escalation). */
export type EscalationPolicy = "abort" | "continue" | "escalate";

/** Queue-level status of a long-horizon task. */
export type LongHorizonStatus =
  | "queued"
  | "running"
  | "scheduled"
  | "waiting_approval"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

/** One step's record on the durable task. */
export interface LongHorizonStep {
  readonly goal: string;
  readonly requiresApproval: boolean;
  readonly scheduledFor?: string | undefined;
  /** Mutable by the manager alone; persisted on every transition. */
  status:
    | "pending"
    | "running"
    | "waiting_approval"
    | "succeeded"
    | "failed"
    | "not_run";
  /**
   * Recorded when a human approved this step (durable across restarts). An
   * approval is a decision about this step, not a property of the process
   * that happened to receive it — losing it on restart would ask a human to
   * answer the same question twice.
   */
  approval?: "granted" | undefined;
  /** The child task the execution primitive created for this step, once it ran. */
  childTaskId?: string | undefined;
  /** The child's final status, as the primitive reported it. */
  childStatus?: string | undefined;
  detail?: string | undefined;
}

/** The durable record of a long-horizon task. */
export interface LongHorizonTask {
  readonly id: string;
  readonly tenantId: string;
  readonly goal: string;
  readonly steps: LongHorizonStep[];
  readonly createdAt: string;
  updatedAt: string;
  status: LongHorizonStatus;
  /** Index of the step the manager is on / will resume from. */
  currentStep: number;
  /** What a non-succeeded step triggers (P1.8). */
  escalation: EscalationPolicy;
  /** Finish-by instant for the WHOLE task; checked before every step (P1.8). */
  deadline?: string | undefined;
  /** Task identity (P1.1), carried into every child task. */
  readonly userId?: string | undefined;
  readonly priority?: string | undefined;
  readonly provenance?: TaskProvenance | undefined;
  /** Why the task is waiting for a human, when it is. */
  waitingReason?: string | undefined;
  /** Earliest instant the current step may run, when status is "scheduled". */
  nextStepAt?: string | undefined;
}

/** The digest a human reads to know where a long-horizon task stands (P1.8). */
export interface LongHorizonDigest {
  readonly taskId: string;
  readonly goal: string;
  readonly status: LongHorizonStatus;
  readonly steps: {
    readonly total: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly pending: number;
  };
  readonly nextStep?: string | undefined;
  readonly deadline?: string | undefined;
  readonly waitingReason?: string | undefined;
  readonly updatedAt: string;
}

/** What the manager needs from the execution primitive to run a step. */
export interface StepExecutor {
  (launch: {
    tenantId: string;
    goal: string;
    parentTaskId: string;
    userId?: string | undefined;
    priority?: string | undefined;
    deadline?: string | undefined;
    provenance: TaskProvenance;
  }): Promise<{ taskId: string; status: ExecutionStatus | string; summary: string }>;
}

export interface LongHorizonDeps {
  /** Directory the state file lives in; created if absent. */
  readonly rootPath: string;
  /** The execution primitive — `engine.execute` in production. */
  readonly execute: StepExecutor;
  /** Injectable clock; tests move time without sleeping. */
  readonly now?: (() => Date) | undefined;
}

interface StateFile {
  readonly version: 1;
  readonly tasks: LongHorizonTask[];
}

const STATE_NAME = "long-horizon-tasks.json";

export class LongHorizonTaskManager {
  private tasks: LongHorizonTask[] = [];
  private loaded = false;
  private running = false;

  constructor(private readonly deps: LongHorizonDeps) {}

  private get path(): string {
    return join(this.deps.rootPath, "long-horizon", STATE_NAME);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as StateFile;
      if (Array.isArray(parsed.tasks)) {
        this.tasks = parsed.tasks;
        // A task found `running` after a restart is mid-step in a process that
        // no longer exists. Re-queue it: the step re-runs under the same
        // idempotency key, and pretending it finished would be inventing a
        // result nobody produced.
        for (const task of this.tasks) {
          if (task.status === "running") {
            task.status = "queued";
            task.updatedAt = this.now().toISOString();
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await atomicWrite(this.path, `${JSON.stringify({ version: 1, tasks: this.tasks } as StateFile, null, 2)}\n`);
  }

  private find(taskId: string): LongHorizonTask | undefined {
    return this.tasks.find((task) => task.id === taskId);
  }

  /**
   * Submit a long-horizon task: a goal broken into steps that each run through
   * the execution primitive, as its children.
   */
  async submit(spec: {
    tenantId: string;
    goal: string;
    steps: readonly LongHorizonStepSpec[];
    escalation?: EscalationPolicy | undefined;
    deadline?: string | undefined;
    userId?: string | undefined;
    priority?: string | undefined;
    provenance?: TaskProvenance | undefined;
  }): Promise<LongHorizonTask> {
    await this.load();
    if (spec.steps.length === 0) {
      throw new Error("A long-horizon task needs at least one step.");
    }
    const now = this.now().toISOString();
    const task: LongHorizonTask = {
      id: `lht-${randomUUID()}`,
      tenantId: spec.tenantId,
      goal: spec.goal,
      steps: spec.steps.map((step) => ({
        goal: step.goal,
        requiresApproval: step.requiresApproval === true,
        ...(step.scheduledFor !== undefined ? { scheduledFor: step.scheduledFor } : {}),
        status: "pending",
      })),
      createdAt: now,
      updatedAt: now,
      status: "queued",
      currentStep: 0,
      escalation: spec.escalation ?? "abort",
      ...(spec.deadline !== undefined ? { deadline: spec.deadline } : {}),
      ...(spec.userId !== undefined ? { userId: spec.userId } : {}),
      ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
      ...(spec.provenance !== undefined ? { provenance: spec.provenance } : {}),
    };
    this.tasks.push(task);
    await this.persist();
    return structuredClone(task);
  }

  /**
   * Pause: the current step (if running) finishes; the task parks after it.
   *
   * An in-flight child task is a real side effect and cannot be recalled from
   * here — so the pause is recorded on the durable status, and the run loop,
   * which re-reads the status at every step boundary, is what actually parks
   * the task. (Writing nothing while `running` — an earlier draft of this
   * method — parks nothing: the loop checks a flag nobody ever sets.)
   */
  async pause(taskId: string): Promise<LongHorizonTask> {
    await this.load();
    const task = this.find(taskId);
    if (task === undefined) throw new Error(`No long-horizon task ${taskId}.`);
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
      // A finished task has nothing to pause; saying otherwise would imply
      // work is still movable.
      throw new Error(`Task ${taskId} is ${task.status}; there is nothing to pause.`);
    }
    task.status = "paused";
    task.waitingReason = undefined;
    task.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(task);
  }

  async resume(taskId: string): Promise<LongHorizonTask> {
    await this.load();
    const task = this.find(taskId);
    if (task === undefined) throw new Error(`No long-horizon task ${taskId}.`);
    if (task.status !== "paused") {
      throw new Error(`Task ${taskId} is ${task.status}; only a paused task can resume.`);
    }
    task.status = "queued";
    task.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(task);
  }

  /** Answer a human-approval wait (P1.8). */
  async approve(
    taskId: string,
    decision: "approved" | "rejected",
    note?: string,
  ): Promise<LongHorizonTask> {
    await this.load();
    const task = this.find(taskId);
    if (task === undefined) throw new Error(`No long-horizon task ${taskId}.`);
    if (task.status !== "waiting_approval") {
      throw new Error(`Task ${taskId} is ${task.status}, not waiting for approval.`);
    }
    if (decision === "rejected") {
      const step = task.steps[task.currentStep];
      if (step !== undefined) step.status = "not_run";
      for (let index = task.currentStep + 1; index < task.steps.length; index += 1) {
        task.steps[index]!.status = "not_run";
      }
      task.status = "failed";
      task.waitingReason = undefined;
      task.updatedAt = this.now().toISOString();
      await this.persist();
      return structuredClone(task);
    }
    // Approved. Two different waits land here, and they mean different things:
    //
    //  - a step waiting BEFORE it ran (`requiresApproval`) may now run;
    //  - a step that ran, failed, and escalated — "approved" means *continue
    //    past it*, not *run it again*. Re-running would turn a human's "carry
    //    on" into a retry nobody asked for.
    const step = task.steps[task.currentStep];
    if (step !== undefined && step.status === "failed") {
      // Continue past the failed step. Remaining steps must still run —
      // finalising here would end the task without them — and the task's own
      // final status is decided honestly (recorded failures included) when
      // the run reaches its end.
      task.currentStep += 1;
      if (task.currentStep >= task.steps.length) this.finalize(task);
    } else if (step !== undefined) {
      step.status = "pending";
      // Durable: without this, the run loop would see the same
      // `requiresApproval` step pending again and re-enter the wait — asking
      // the human the same question forever.
      if (step.requiresApproval) step.approval = "granted";
    }
    task.waitingReason = undefined;
    // `finalize` may already have ended the task (succeeded/failed); only a
    // task still parked on the wait goes back to the queue.
    if (task.status === "waiting_approval") task.status = "queued";
    task.updatedAt = this.now().toISOString();
    await this.persist();
    void note;
    return structuredClone(task);
  }

  /**
   * Advance every runnable task by whatever the moment allows.
   *
   * One task runs at a time and tasks run in submission order: a queue that
   * starts the second task while the first is still mid-flight is two queues
   * wearing one name.
   */
  async tick(): Promise<void> {
    await this.load();
    if (this.running) return;
    this.running = true;
    try {
      for (const task of [...this.tasks]) {
        if (task.status !== "queued" && task.status !== "scheduled") continue;
        await this.runTask(task);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * A task whose steps have all been dispositioned ends `succeeded` only if
   * none of them failed. Reporting success over recorded failures — which the
   * "continue" escalation policy makes reachable — would be exactly the lie
   * this manager exists to prevent.
   */
  private finalize(task: LongHorizonTask): void {
    if (task.currentStep < task.steps.length) return;
    task.status = task.steps.some((step) => step.status === "failed") ? "failed" : "succeeded";
    task.waitingReason = undefined;
    task.nextStepAt = undefined;
  }

  private async runTask(task: LongHorizonTask): Promise<void> {
    this.finalize(task);
    while (task.currentStep < task.steps.length) {
      // Fresh reads every iteration: pause/approve mutate the record while a
      // step runs, and the loop must honour them at the next boundary.
      if (task.status === "paused") return;

      if (task.deadline !== undefined && this.now() > new Date(task.deadline)) {
        task.steps[task.currentStep]!.status = "not_run";
        for (let index = task.currentStep + 1; index < task.steps.length; index += 1) {
          task.steps[index]!.status = "not_run";
        }
        task.status = "failed";
        task.waitingReason = undefined;
        task.updatedAt = this.now().toISOString();
        await this.persist();
        return;
      }

      const step = task.steps[task.currentStep]!;

      if (step.status === "waiting_approval") {
        task.status = "waiting_approval";
        task.updatedAt = this.now().toISOString();
        await this.persist();
        return;
      }

      if (step.scheduledFor !== undefined && this.now() < new Date(step.scheduledFor)) {
        step.status = "pending";
        task.status = "scheduled";
        task.nextStepAt = step.scheduledFor;
        task.updatedAt = this.now().toISOString();
        await this.persist();
        return;
      }

      if (step.requiresApproval && step.approval !== "granted" && step.status === "pending") {
        step.status = "waiting_approval";
        task.status = "waiting_approval";
        task.waitingReason = `Step ${task.currentStep + 1} requires human approval before it runs`;
        task.updatedAt = this.now().toISOString();
        await this.persist();
        return;
      }

      // Run the step as a child task through the full primitive.
      step.status = "running";
      task.status = "running";
      task.updatedAt = this.now().toISOString();
      await this.persist();

      let report: Awaited<ReturnType<StepExecutor>>;
      try {
        report = await this.deps.execute({
          tenantId: task.tenantId,
          goal: step.goal,
          parentTaskId: task.id,
          ...(task.userId !== undefined ? { userId: task.userId } : {}),
          ...(task.priority !== undefined ? { priority: task.priority } : {}),
          ...(task.deadline !== undefined ? { deadline: task.deadline } : {}),
          // Each step is a continuation the manager drives; that is its origin.
          provenance: { surface: "background", ref: task.id },
        });
      } catch (error) {
        report = {
          taskId: "",
          status: "failed",
          summary: error instanceof Error ? error.message : String(error),
        };
      }

      step.childTaskId = report.taskId || undefined;
      step.childStatus = String(report.status);
      step.detail = report.summary;
      step.status = report.status === "succeeded" ? "succeeded" : "failed";
      task.updatedAt = this.now().toISOString();

      if (step.status === "succeeded") {
        task.currentStep += 1;
        this.finalize(task);
        await this.persist();
        continue;
      }

      // Failure escalation (P1.8). The three policies say exactly what they
      // mean: stop and keep the record; push on and record the damage; or put
      // the decision in a human's hands.
      if (task.escalation === "abort") {
        for (let index = task.currentStep + 1; index < task.steps.length; index += 1) {
          task.steps[index]!.status = "not_run";
        }
        task.status = "failed";
        await this.persist();
        return;
      }
      if (task.escalation === "escalate") {
        task.status = "waiting_approval";
        task.waitingReason = `Step ${task.currentStep + 1} ended "${report.status}"; a human decides whether to continue`;
        await this.persist();
        return;
      }
      // "continue": record the failure and move to the next step.
      task.currentStep += 1;
      this.finalize(task);
      await this.persist();
    }
  }

  async get(taskId: string): Promise<LongHorizonTask | undefined> {
    await this.load();
    const task = this.find(taskId);
    return task === undefined ? undefined : structuredClone(task);
  }

  async list(tenantId?: string): Promise<readonly LongHorizonTask[]> {
    await this.load();
    return structuredClone(
      tenantId === undefined ? this.tasks : this.tasks.filter((task) => task.tenantId === tenantId),
    );
  }

  /** Where every task stands, for a human (P1.8: progress digest). */
  async digest(tenantId?: string): Promise<readonly LongHorizonDigest[]> {
    await this.load();
    const tasks = tenantId === undefined ? this.tasks : this.tasks.filter((t) => t.tenantId === tenantId);
    return tasks.map((task) => {
      const next = task.steps[task.currentStep];
      return {
        taskId: task.id,
        goal: task.goal,
        status: task.status,
        steps: {
          total: task.steps.length,
          succeeded: task.steps.filter((s) => s.status === "succeeded").length,
          failed: task.steps.filter((s) => s.status === "failed").length,
          pending: task.steps.filter((s) => s.status === "pending" || s.status === "waiting_approval").length,
        },
        ...(next !== undefined ? { nextStep: next.goal } : {}),
        ...(task.deadline !== undefined ? { deadline: task.deadline } : {}),
        ...(task.waitingReason !== undefined ? { waitingReason: task.waitingReason } : {}),
        updatedAt: task.updatedAt,
      };
    });
  }
}
