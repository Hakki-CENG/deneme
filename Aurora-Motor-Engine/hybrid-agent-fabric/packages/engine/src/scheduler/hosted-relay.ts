import { createRemoteJWKSet, jwtVerify } from "jose";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalScheduleProvider, ScheduledJob, DurableScheduler } from "./scheduler.js";
import { atomicWrite } from "../util/atomic-file.js";
import { AsyncMutex } from "../util/async-mutex.js";

export interface HostedSchedulerRelayOptions {
  portalUrl: string;
  accessToken: string;
  callbackUrl: string;
  expectedAudience: string;
  issuer: string;
  jwksUrl: string;
  purpose?: string;
  requestTimeoutMs?: number;
}

interface FireClaim {
  key: string;
  jobId: string;
  fireAt: string;
  claimedAt: string;
  status: "claimed" | "completed" | "failed" | "uncertain" | "stale";
}

export class HostedSchedulerRelay implements ExternalScheduleProvider {
  readonly id = "hosted-relay";
  private readonly portalUrl: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private claims: FireClaim[] = [];
  private loaded = false;
  private readonly mutex = new AsyncMutex();

  constructor(
    private readonly rootPath: string,
    private readonly options: HostedSchedulerRelayOptions,
  ) {
    this.portalUrl = new URL(options.portalUrl).toString().replace(/\/$/, "");
    const callback = new URL(options.callbackUrl);
    if (callback.protocol !== "https:" && callback.protocol !== "http:") throw new Error("Hosted scheduler callback must use HTTP(S).");
    this.jwks = createRemoteJWKSet(new URL(options.jwksUrl));
  }

  private get ledgerPath(): string { return join(this.rootPath, "scheduler", "hosted-fire-ledger.json"); }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.ledgerPath, "utf8")) as unknown;
      this.claims = Array.isArray(parsed) ? parsed as FireClaim[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }
  private async save(): Promise<void> {
    this.claims = this.claims.slice(-20_000);
    await atomicWrite(this.ledgerPath, `${JSON.stringify(this.claims, null, 2)}\n`);
  }

  async arm(job: ScheduledJob): Promise<void> {
    if (!job.nextRunAt || job.status !== "active") return;
    await this.request("POST", "/api/agent-cron/provision", {
      job_id: job.id,
      fire_at: job.nextRunAt,
      agent_callback_url: this.options.callbackUrl,
      dedup_key: `${job.id}:${job.nextRunAt}`,
    });
  }

  async cancel(jobId: string): Promise<void> {
    await this.request("POST", "/api/agent-cron/cancel", { job_id: jobId });
  }

  async verifyFire(token: string): Promise<{ jobId: string; fireAt: string }> {
    const verified = await jwtVerify(token, this.jwks, {
      issuer: this.options.issuer,
      audience: this.options.expectedAudience,
      clockTolerance: 30,
    });
    if (verified.payload.purpose !== (this.options.purpose ?? "cron_fire")) throw new Error("Hosted scheduler JWT purpose is invalid.");
    if (typeof verified.payload.job_id !== "string" || typeof verified.payload.fire_at !== "string") throw new Error("Hosted scheduler JWT is missing job identity.");
    return { jobId: verified.payload.job_id, fireAt: verified.payload.fire_at };
  }

  async handleFire(token: string, body: { job_id?: string; fire_at?: string }, scheduler: DurableScheduler): Promise<{ accepted: boolean; status: string }> {
    const claims = await this.verifyFire(token);
    if ((body.job_id && body.job_id !== claims.jobId) || (body.fire_at && body.fire_at !== claims.fireAt)) throw new Error("Hosted scheduler body/JWT mismatch.");
    const key = `${claims.jobId}:${claims.fireAt}`;
    const acquired = await this.mutex.runExclusive(async () => {
      await this.load();
      if (this.claims.some((claim) => claim.key === key)) return false;
      this.claims.push({ key, jobId: claims.jobId, fireAt: claims.fireAt, claimedAt: new Date().toISOString(), status: "claimed" });
      await this.save();
      return true;
    });
    if (!acquired) return { accepted: true, status: "duplicate" };
    let status: FireClaim["status"] = "failed";
    try {
      const result = await scheduler.fireExternal(claims.jobId, claims.fireAt);
      status = result.status === "duplicate" || result.status === "stale" ? "stale" : result.status;
      return { accepted: true, status: result.status };
    } finally {
      await this.mutex.runExclusive(async () => {
        const claim = this.claims.find((item) => item.key === key);
        if (claim) claim.status = status;
        await this.save();
      });
    }
  }

  async reconcile(jobs: ScheduledJob[]): Promise<{ armed: number; cancelled: number }> {
    let armed = 0;
    for (const job of jobs) {
      if (job.status === "active" && job.nextRunAt) { await this.arm(job); armed++; }
      else await this.cancel(job.id);
    }
    return { armed, cancelled: jobs.length - armed };
  }

  private async request(method: string, path: string, body: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 10_000);
    timer.unref();
    try {
      const response = await fetch(`${this.portalUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Hosted scheduler relay HTTP ${response.status}.`);
      return response.status === 204 ? {} : await response.json();
    } finally { clearTimeout(timer); }
  }
}
