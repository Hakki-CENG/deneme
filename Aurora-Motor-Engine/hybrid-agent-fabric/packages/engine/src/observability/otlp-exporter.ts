import type { OperationalMetrics, OperationalSnapshot } from "./operational-metrics.js";
import { ENGINE_VERSION } from "../version.js";

export interface OtlpExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  intervalMs?: number;
  serviceName?: string;
  serviceVersion?: string;
  instanceId?: string;
}

export interface OtlpExporterStatus {
  running: boolean;
  exportsTotal: number;
  failuresTotal: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureClass?: string;
}

function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function point(value: number, timeUnixNano: string, attributes: Array<ReturnType<typeof attribute>> = []) {
  return { asDouble: value, timeUnixNano, attributes };
}

function sumMetric(name: string, value: number, timeUnixNano: string, attributes: Array<ReturnType<typeof attribute>> = []) {
  return {
    name,
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: [point(value, timeUnixNano, attributes)],
    },
  };
}

function gaugeMetric(name: string, value: number, timeUnixNano: string, attributes: Array<ReturnType<typeof attribute>> = []) {
  return { name, gauge: { dataPoints: [point(value, timeUnixNano, attributes)] } };
}

export function buildOtlpMetricPayload(snapshot: OperationalSnapshot, options: OtlpExporterOptions): unknown {
  const timeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
  const metrics: unknown[] = [
    gaugeMetric("haf.uptime.seconds", snapshot.uptimeSeconds, timeUnixNano),
    sumMetric("haf.events.total", snapshot.eventsTotal, timeUnixNano),
    sumMetric("haf.model.requests.total", snapshot.modelRequestsTotal, timeUnixNano),
    sumMetric("haf.capability.calls.total", snapshot.capabilityCallsTotal, timeUnixNano),
    sumMetric("haf.capability.failures.total", snapshot.capabilityFailuresTotal, timeUnixNano),
    sumMetric("haf.model.tokens.total", snapshot.inputTokensTotal, timeUnixNano, [attribute("haf.token.kind", "input")]),
    sumMetric("haf.model.tokens.total", snapshot.outputTokensTotal, timeUnixNano, [attribute("haf.token.kind", "output")]),
    sumMetric("haf.model.tokens.total", snapshot.cacheReadTokensTotal, timeUnixNano, [attribute("haf.token.kind", "cache_read")]),
    sumMetric("haf.model.tokens.total", snapshot.cacheWriteTokensTotal, timeUnixNano, [attribute("haf.token.kind", "cache_write")]),
    ...Object.entries(snapshot.sessionsByStatus).map(([status, value]) =>
      gaugeMetric("haf.sessions", value, timeUnixNano, [attribute("haf.session.status", status)])),
    ...Object.entries(snapshot.capabilityCallsById).map(([capability, value]) =>
      sumMetric("haf.capability.calls.by_id.total", value, timeUnixNano, [attribute("haf.capability.id", capability)])),
  ];
  return {
    resourceMetrics: [{
      resource: {
        attributes: [
          attribute("service.name", options.serviceName ?? "hybrid-agent-fabric"),
          attribute("service.version", options.serviceVersion ?? ENGINE_VERSION),
          ...(options.instanceId ? [attribute("service.instance.id", options.instanceId)] : []),
        ],
      },
      scopeMetrics: [{
        scope: { name: "haf.operational", version: ENGINE_VERSION },
        metrics,
      }],
    }],
  };
}

export class OtlpMetricsExporter {
  private timer: NodeJS.Timeout | undefined;
  private exporting = false;
  private state: OtlpExporterStatus = { running: false, exportsTotal: 0, failuresTotal: 0 };

  constructor(
    private readonly metrics: OperationalMetrics,
    private readonly options: OtlpExporterOptions,
  ) {
    const url = new URL(options.endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("OTLP endpoint must use HTTP(S).");
  }

  status(): OtlpExporterStatus {
    return structuredClone(this.state);
  }

  start(): void {
    if (this.timer) return;
    this.state.running = true;
    this.timer = setInterval(() => void this.exportNow(), this.options.intervalMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.state.running = false;
  }

  async exportNow(): Promise<boolean> {
    if (this.exporting) return false;
    this.exporting = true;
    try {
      const response = await fetch(this.options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.options.headers,
        },
        body: JSON.stringify(buildOtlpMetricPayload(this.metrics.snapshot(), this.options)),
      });
      if (!response.ok) throw new Error(`OTLP HTTP ${response.status}`);
      this.state.exportsTotal++;
      this.state.lastSuccessAt = new Date().toISOString();
      delete this.state.lastFailureClass;
      return true;
    } catch (error) {
      this.state.failuresTotal++;
      this.state.lastFailureAt = new Date().toISOString();
      this.state.lastFailureClass = error instanceof Error ? error.name : "unknown";
      return false;
    } finally {
      this.exporting = false;
    }
  }
}
