/**
 * Aurora Structured Logger
 * Provides consistent, structured logging across all services.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  tenantId?: string | undefined;
  traceId?: string | undefined;
  spanId?: string | undefined;
  duration?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  error?: { name: string; message: string; stack?: string | undefined } | undefined;
}

export interface AuditEntry {
  timestamp: string;
  action: string;
  tenantId: string;
  userId?: string;
  resource: string;
  resourceId: string;
  outcome: "success" | "failure" | "denied";
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3, fatal: 4,
};

export class AuroraLogger {
  private minLevel: LogLevel;
  private serviceName: string;
  private logBuffer: LogEntry[] = [];
  private auditBuffer: AuditEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  constructor(serviceName: string, minLevel: LogLevel = "info") {
    this.serviceName = serviceName;
    this.minLevel = minLevel;
  }

  start(flushIntervalMs: number = 10000): void {
    this.flushInterval = setInterval(() => this.flush(), flushIntervalMs);
  }

  stop(): void {
    if (this.flushInterval) clearInterval(this.flushInterval);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log("warn", message, meta);
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "error",
      service: this.serviceName,
      message,
      metadata: meta,
    };
    if (error) {
      entry.error = { name: error.name, message: error.message, stack: error.stack };
    }
    this.logBuffer.push(entry);
    this.output(entry);
  }

  fatal(message: string, error?: Error, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "fatal",
      service: this.serviceName,
      message,
      metadata: meta,
    };
    if (error) {
      entry.error = { name: error.name, message: error.message, stack: error.stack };
    }
    this.logBuffer.push(entry);
    this.output(entry);
  }

  audit(entry: Omit<AuditEntry, "timestamp">): void {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    this.auditBuffer.push(fullEntry);
    this.outputAudit(fullEntry);
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.minLevel]) return;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      message,
      metadata: meta,
    };
    this.logBuffer.push(entry);
    this.output(entry);
  }

  private output(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    switch (entry.level) {
      case "debug": console.debug(line); break;
      case "info": console.log(line); break;
      case "warn": console.warn(line); break;
      case "error":
      case "fatal": console.error(line); break;
    }
  }

  private outputAudit(entry: AuditEntry): void {
    console.log(JSON.stringify({ ...entry, _type: "audit" }));
  }

  flush(): LogEntry[] {
    const logs = [...this.logBuffer];
    this.logBuffer = [];
    return logs;
  }

  flushAudit(): AuditEntry[] {
    const audits = [...this.auditBuffer];
    this.auditBuffer = [];
    return audits;
  }

  getStats(): { logCount: number; auditCount: number; minLevel: LogLevel } {
    return { logCount: this.logBuffer.length, auditCount: this.auditBuffer.length, minLevel: this.minLevel };
  }
}

// Singleton logger for the engine
let _engineLogger: AuroraLogger | null = null;

export function getEngineLogger(): AuroraLogger {
  if (!_engineLogger) _engineLogger = new AuroraLogger("aurora-engine", "info");
  return _engineLogger;
}

export function setEngineLogger(logger: AuroraLogger): void {
  _engineLogger = logger;
}
