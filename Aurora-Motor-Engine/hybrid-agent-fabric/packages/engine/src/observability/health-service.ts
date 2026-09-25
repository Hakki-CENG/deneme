/**
 * P2.45 health model — component-level, measured, honest.
 *
 * The old `/health` answered `{ status: "ok" }` unconditionally: it never
 * asked any component anything, so a runtime with a dead database and no
 * model providers reported the same "ok" as a healthy one. That is a health
 * endpoint that cannot fail, which is the same as not having one.
 *
 * This service asks every component it can actually reach:
 *
 *  - model providers: their own `status()` detail, when they expose one
 *  - persistence: a real `SELECT 1` round-trip when Postgres is configured;
 *    "file" mode is reported as file mode, not as a passed database check
 *  - NATS: whether a transport is configured (a connectivity probe would
 *    need a live broker; absence is reported as absent)
 *  - scheduler: how many jobs are active
 *  - memory and cognitive health: the existing tenant-scoped health checks
 *
 * Rules:
 *  - "unknown" is a valid answer and is labelled as such. A provider without
 *    a status() implementation is "unknown", not "healthy".
 *  - The overall status is "ok" or "degraded" — never "down", because the
 *    process answering the request is, by definition, up.
 *  - Nothing here mutates state; every check is a read.
 */

export interface HealthComponent {
  name: string;
  status: "ok" | "degraded" | "unknown";
  detail: string;
}

export interface HealthReport {
  status: "ok" | "degraded";
  checkedAt: string;
  components: HealthComponent[];
}

export interface HealthDependencies {
  /** Registered model providers with their self-reported status, if any. */
  modelProviders: () => Array<{ id: string; detail?: unknown }>;
  /** Executes a database round-trip; absent means no database is configured. */
  pingDatabase?: () => Promise<void>;
  persistenceMode: "postgres" | "file";
  natsConfigured: boolean;
  activeScheduledJobs: () => Promise<number>;
  /**
   * Tenant-scoped subsystem snapshots. These return data (totals, stale
   * lists), not verdicts — the honest claim a health check can make from a
   * successful call is "the subsystem answered", so the component is "ok"
   * when it responds and "degraded" when it throws; the summary is reported
   * verbatim rather than collapsed into a smiley.
   */
  memoryHealth: (tenantId: string) => Promise<unknown>;
  cognitiveHealth: (tenantId: string) => Promise<unknown>;
}

export class HealthService {
  constructor(private readonly deps: HealthDependencies) {}

  async report(tenantId = "local"): Promise<HealthReport> {
    const components: HealthComponent[] = [];

    // Model providers: each answers for itself; no status() means unknown.
    const providers = this.deps.modelProviders();
    if (providers.length === 0) {
      components.push({ name: "model-providers", status: "degraded", detail: "No model provider is registered." });
    } else {
      const withDetail = providers.filter((provider) => provider.detail !== undefined && provider.detail !== null);
      const degraded = withDetail.filter((provider) => {
        const detail = provider.detail as Record<string, unknown>;
        return typeof detail.status === "string" && !["ok", "healthy", "active"].includes(detail.status.toLowerCase());
      });
      components.push({
        name: "model-providers",
        status: degraded.length > 0 ? "degraded" : withDetail.length > 0 ? "ok" : "unknown",
        detail: degraded.length > 0
          ? `${degraded.length}/${providers.length} provider(s) report a non-healthy status: ${degraded.map((provider) => provider.id).join(", ")}.`
          : withDetail.length > 0
            ? `${providers.length} provider(s) registered; ${withDetail.length} report healthy.`
            : `${providers.length} provider(s) registered; none exposes a health status (unknown, not assumed healthy).`,
      });
    }

    // Persistence: a real round-trip when Postgres is configured.
    if (this.deps.pingDatabase) {
      try {
        await this.deps.pingDatabase();
        components.push({ name: "persistence", status: "ok", detail: `PostgreSQL reachable (SELECT 1 round-trip).` });
      } catch (error) {
        components.push({ name: "persistence", status: "degraded", detail: `PostgreSQL unreachable: ${(error as Error).message}` });
      }
    } else {
      components.push({ name: "persistence", status: "unknown", detail: `File-based persistence; no database round-trip was performed (not configured, not assumed).` });
    }

    components.push({
      name: "nats",
      status: this.deps.natsConfigured ? "ok" : "unknown",
      detail: this.deps.natsConfigured
        ? "NATS transport is configured; a live connectivity probe is not performed here."
        : "No NATS transport is configured.",
    });

    try {
      const activeJobs = await this.deps.activeScheduledJobs();
      components.push({ name: "scheduler", status: "ok", detail: `${activeJobs} active scheduled job(s).` });
    } catch (error) {
      components.push({ name: "scheduler", status: "degraded", detail: `Scheduled job count unavailable: ${(error as Error).message}` });
    }

    for (const [name, check] of [
      ["memory", this.deps.memoryHealth],
      ["cognitive", this.deps.cognitiveHealth],
    ] as const) {
      try {
        const snapshot = (await check(tenantId)) as Record<string, unknown>;
        const summary = Object.entries(snapshot)
          .filter(([, value]) => typeof value === "number" || typeof value === "string")
          .slice(0, 4)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(", ");
        components.push({ name, status: "ok", detail: `subsystem responded (${summary || "no scalar fields"})` });
      } catch (error) {
        components.push({ name, status: "degraded", detail: `health check failed: ${(error as Error).message}` });
      }
    }

    return {
      status: components.some((component) => component.status === "degraded") ? "degraded" : "ok",
      checkedAt: new Date().toISOString(),
      components,
    };
  }
}
