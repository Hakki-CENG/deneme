import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { Supervisor } from "../runtime/supervisor.js";
import { atomicWrite } from "../util/atomic-file.js";

export type Schedule =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expression: string; timezone?: string };

export interface ScheduledJob {
  id: string;
  tenantId: string;
  sessionId: string;
  label?: string;
  prompt: string;
  schedule: Schedule;
  status: "active" | "paused" | "completed" | "cancelled";
  nextRunAt?: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastOutcome?: "completed" | "failed" | "uncertain";
}

export interface ExternalScheduleProvider {
  readonly id: string;
  arm(job: ScheduledJob): Promise<void>;
  cancel(jobId: string): Promise<void>;
  close?(): Promise<void>;
}

function nextOccurrence(schedule: Schedule, after: Date): Date | undefined {
  if (schedule.kind === "once") {
    const date = new Date(schedule.at);
    return date > after ? date : undefined;
  }
  if (schedule.kind === "interval") return new Date(after.getTime() + schedule.everyMs);
  const expression = CronExpressionParser.parse(schedule.expression, {
    currentDate: after,
    ...(schedule.timezone ? { tz: schedule.timezone } : {}),
  });
  return expression.next().toDate();
}

export class DurableScheduler {
  private jobs: ScheduledJob[] = [];
  private loaded = false;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly rootPath: string,
    private readonly supervisor: Supervisor,
    private readonly externalProvider?: ExternalScheduleProvider,
  ) {}

  private get path(): string {
    return join(this.rootPath, "scheduler", "jobs.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.jobs = Array.isArray(parsed) ? (parsed as ScheduledJob[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(this.jobs, null, 2)}\n`);
  }

  async create(input: { tenantId: string; sessionId: string; prompt: string; schedule: Schedule; label?: string }): Promise<ScheduledJob> {
    await this.load();
    if (!input.prompt.trim()) throw new Error("Scheduled prompt cannot be empty.");
    if (input.schedule.kind === "interval" && input.schedule.everyMs < 1000) throw new Error("Minimum interval is 1000 ms.");
    const now = new Date();
    const next = nextOccurrence(input.schedule, new Date(now.getTime() - 1));
    if (!next) throw new Error("Schedule has no future occurrence.");
    const job: ScheduledJob = {
      id: randomUUID(),
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      ...(input.label ? { label: input.label } : {}),
      prompt: input.prompt,
      schedule: input.schedule,
      status: "active",
      nextRunAt: next.toISOString(),
      runCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.jobs.push(job);
    await this.save();
    if (this.externalProvider) await this.externalProvider.arm(job);
    return structuredClone(job);
  }

  async list(tenantId?: string): Promise<ScheduledJob[]> {
    await this.load();
    return this.jobs.filter((job) => !tenantId || job.tenantId === tenantId).map((job) => structuredClone(job));
  }

  async setStatus(id: string, status: "active" | "paused" | "cancelled"): Promise<ScheduledJob> {
    await this.load();
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw new Error(`Scheduled job ${id} not found.`);
    job.status = status;
    job.updatedAt = new Date().toISOString();
    if (status === "active") {
      const next = nextOccurrence(job.schedule, new Date());
      if (next) job.nextRunAt = next.toISOString();
      else delete job.nextRunAt;
    } else delete job.nextRunAt;
    await this.save();
    if (this.externalProvider) {
      if (status === "active" && job.nextRunAt) await this.externalProvider.arm(job);
      else await this.externalProvider.cancel(job.id);
    }
    return structuredClone(job);
  }

  start(intervalMs = 1000): void {
    if (this.externalProvider) return;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async fireExternal(jobId: string, fireAt: string): Promise<{ status: "completed" | "failed" | "uncertain" | "duplicate" | "stale" }> {
    if (!this.externalProvider) throw new Error("External scheduler provider is not configured.");
    await this.load();
    const job = this.jobs.find((item) => item.id === jobId);
    if (!job || job.status !== "active") return { status: "stale" };
    if (job.lastRunAt === fireAt) return { status: "duplicate" };
    if (!job.nextRunAt || job.nextRunAt !== fireAt) return { status: "stale" };
    const fireDate = new Date(fireAt);
    if (!Number.isFinite(fireDate.getTime())) return { status: "stale" };
    if (job.schedule.kind === "once") {
      job.status = "completed";
      delete job.nextRunAt;
    } else {
      const next = nextOccurrence(job.schedule, fireDate);
      if (next) job.nextRunAt = next.toISOString();
      else delete job.nextRunAt;
    }
    job.lastRunAt = fireAt;
    job.runCount++;
    job.updatedAt = new Date().toISOString();
    await this.save();
    const result = await this.supervisor.dispatch({
      protocolVersion: 1,
      commandId: `external-schedule:${job.id}:${fireAt}`,
      clientId: `external-scheduler:${this.externalProvider.id}`,
      tenantId: job.tenantId,
      sessionId: job.sessionId,
      kind: "session.prompt",
      source: "scheduler",
      issuedAt: new Date().toISOString(),
      payload: { text: job.prompt, scheduledJobId: job.id, scheduledAt: fireAt, externalProvider: this.externalProvider.id },
    });
    job.lastOutcome = result.status === "completed" ? "completed" : result.status === "uncertain" ? "uncertain" : "failed";
    job.updatedAt = new Date().toISOString();
    await this.save();
    if (job.status === "active" && job.nextRunAt) await this.externalProvider.arm(job);
    else await this.externalProvider.cancel(job.id);
    return { status: job.lastOutcome };
  }

  async close(): Promise<void> {
    this.stop();
    await this.externalProvider?.close?.();
  }

  async tick(now = new Date()): Promise<void> {
    if (this.externalProvider || this.ticking) return;
    this.ticking = true;
    try {
      await this.load();
      const due = this.jobs.filter((job) => job.status === "active" && job.nextRunAt && new Date(job.nextRunAt) <= now);
      for (const job of due) {
        const occurrence = job.nextRunAt!;
        // Advance/complete durably before dispatch. A crash never replays an uncertain fire.
        if (job.schedule.kind === "once") {
          job.status = "completed";
          delete job.nextRunAt;
        } else {
          const next = nextOccurrence(job.schedule, now);
          if (next) job.nextRunAt = next.toISOString();
          else delete job.nextRunAt;
        }
        job.lastRunAt = occurrence;
        job.runCount++;
        job.updatedAt = now.toISOString();
        await this.save();

        const result = await this.supervisor.dispatch({
          protocolVersion: 1,
          commandId: `schedule:${job.id}:${occurrence}`,
          clientId: "durable-scheduler",
          tenantId: job.tenantId,
          sessionId: job.sessionId,
          kind: "session.prompt",
          source: "scheduler",
          issuedAt: now.toISOString(),
          payload: { text: job.prompt, scheduledJobId: job.id, scheduledAt: occurrence },
        });
        job.lastOutcome = result.status === "completed" ? "completed" : result.status === "uncertain" ? "uncertain" : "failed";
        job.updatedAt = new Date().toISOString();
        await this.save();
      }
    } finally {
      this.ticking = false;
    }
  }
}
