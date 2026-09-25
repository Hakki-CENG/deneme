import { describe, expect, it } from "vitest";
import { AuroraLogger } from "../src/aurora/aurora-logger.js";

describe("P3: Aurora Logger — Structured Logging", () => {
  it("creates logger with service name", () => {
    const logger = new AuroraLogger("test-service", "debug");
    const stats = logger.getStats();
    expect(stats.logCount).toBe(0);
    expect(stats.auditCount).toBe(0);
    expect(stats.minLevel).toBe("debug");
  });

  it("logs at correct levels", () => {
    const logger = new AuroraLogger("test-service", "debug");
    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    
    const stats = logger.getStats();
    expect(stats.logCount).toBe(3);
  });

  it("filters by minimum level", () => {
    const logger = new AuroraLogger("test-service", "warn");
    logger.debug("should not log");
    logger.info("should not log");
    logger.warn("should log");
    logger.error("should log");
    
    const stats = logger.getStats();
    expect(stats.logCount).toBe(2);
  });

  it("flushes log buffer", () => {
    const logger = new AuroraLogger("test-service", "debug");
    logger.info("message 1");
    logger.info("message 2");
    
    const flushed = logger.flush();
    expect(flushed).toHaveLength(2);
    expect(logger.getStats().logCount).toBe(0);
  });

  it("records audit entries", () => {
    const logger = new AuroraLogger("test-service", "debug");
    logger.audit({
      action: "decision.create",
      tenantId: "tenant1",
      resource: "decision",
      resourceId: "dec-123",
      outcome: "success",
    });
    
    const stats = logger.getStats();
    expect(stats.auditCount).toBe(1);
    
    const audits = logger.flushAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("decision.create");
    expect(audits[0].outcome).toBe("success");
  });

  it("handles error logging with Error objects", () => {
    const logger = new AuroraLogger("test-service", "debug");
    const error = new Error("Test error");
    logger.error("Something went wrong", error, { context: "test" });
    
    const flushed = logger.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].error).toBeDefined();
    expect(flushed[0].error?.message).toBe("Test error");
  });

  it("handles fatal logging", () => {
    const logger = new AuroraLogger("test-service", "debug");
    logger.fatal("Critical failure", new Error("Fatal error"));
    
    const flushed = logger.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].level).toBe("fatal");
  });
});
