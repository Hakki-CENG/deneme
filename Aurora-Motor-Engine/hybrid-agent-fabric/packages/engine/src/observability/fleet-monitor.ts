import type { ApprovalService } from "../policy/approval-service.js";
import type { DurableScheduler } from "../scheduler/scheduler.js";
import type { OperationalMetrics } from "./operational-metrics.js";

export interface FleetWorkerSummary {
  running: number;
  recovered: number;
  stale: number;
  unreachable: number;
}

export interface FleetSnapshot {
  capturedAt: string;
  eventsTotal: number;
  modelRequestsTotal: number;
  capabilityCallsTotal: number;
  capabilityFailuresTotal: number;
  sessionsByStatus: Record<string, number>;
  schedules: { active: number; paused: number; completed: number; cancelled: number; overdue: number };
  approvals: { pending: number; oldestAgeSeconds: number };
  workers: FleetWorkerSummary;
  alerts: FleetAlert[];
}

export interface FleetAlert {
  code: string;
  severity: "warning" | "critical";
  value: number;
  threshold: number;
  summary: string;
}

export interface FleetMonitorOptions {
  workerProbe?: () => Promise<FleetWorkerSummary>;
  capabilityFailureRateWarning?: number;
  approvalAgeWarningSeconds?: number;
  overdueCritical?: number;
  unreachableWorkerCritical?: number;
}

export class FleetMonitor {
  constructor(
    private readonly metrics: OperationalMetrics,
    private readonly scheduler: DurableScheduler,
    private readonly approvals: ApprovalService,
    private readonly options: FleetMonitorOptions = {},
  ) {}

  async snapshot(now = new Date()): Promise<FleetSnapshot> {
    const metrics = this.metrics.snapshot();
    const jobs = await this.scheduler.list();
    const schedules = { active: 0, paused: 0, completed: 0, cancelled: 0, overdue: 0 };
    for (const job of jobs) {
      schedules[job.status]++;
      if (job.status === "active" && job.nextRunAt && new Date(job.nextRunAt) < now) schedules.overdue++;
    }
    const pending = this.approvals.list();
    const oldestAgeSeconds = pending.length
      ? Math.max(...pending.map((item) => Math.max(0, (now.getTime() - new Date(item.createdAt).getTime()) / 1000)))
      : 0;
    const workers = this.options.workerProbe
      ? await this.options.workerProbe()
      : { running: 0, recovered: 0, stale: 0, unreachable: 0 };
    const alerts: FleetAlert[] = [];
    const failureRate = metrics.capabilityCallsTotal ? metrics.capabilityFailuresTotal / metrics.capabilityCallsTotal : 0;
    const failureThreshold = this.options.capabilityFailureRateWarning ?? 0.2;
    if (failureRate > failureThreshold) alerts.push({
      code: "capability_failure_rate", severity: "warning", value: failureRate, threshold: failureThreshold,
      summary: "Capability failure rate exceeds the configured threshold.",
    });
    const approvalThreshold = this.options.approvalAgeWarningSeconds ?? 300;
    if (oldestAgeSeconds > approvalThreshold) alerts.push({
      code: "approval_wait_age", severity: "warning", value: oldestAgeSeconds, threshold: approvalThreshold,
      summary: "At least one approval has waited too long.",
    });
    const overdueThreshold = this.options.overdueCritical ?? 0;
    if (schedules.overdue > overdueThreshold) alerts.push({
      code: "scheduler_overdue", severity: "critical", value: schedules.overdue, threshold: overdueThreshold,
      summary: "One or more scheduled jobs are overdue.",
    });
    const unreachable = workers.stale + workers.unreachable;
    const workerThreshold = this.options.unreachableWorkerCritical ?? 0;
    if (unreachable > workerThreshold) alerts.push({
      code: "worker_unreachable", severity: "critical", value: unreachable, threshold: workerThreshold,
      summary: "One or more resident workers are stale or unreachable.",
    });
    return {
      capturedAt: now.toISOString(),
      eventsTotal: metrics.eventsTotal,
      modelRequestsTotal: metrics.modelRequestsTotal,
      capabilityCallsTotal: metrics.capabilityCallsTotal,
      capabilityFailuresTotal: metrics.capabilityFailuresTotal,
      sessionsByStatus: metrics.sessionsByStatus,
      schedules,
      approvals: { pending: pending.length, oldestAgeSeconds: Number(oldestAgeSeconds.toFixed(3)) },
      workers,
      alerts,
    };
  }
}
