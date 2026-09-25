import { describe, expect, it } from "vitest";
import { MemoryEventStore } from "../src/persistence/event-store.js";
import type { EventEnvelope } from "../src/types.js";

function event(sequence: number): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    tenantId: "tenant",
    sessionId: "session",
    familyId: "session",
    generation: 1,
    sequence,
    traceId: "trace",
    type: "test",
    timestamp: new Date().toISOString(),
    visibility: "internal",
    redactionClass: "none",
    payload: { sequence },
  };
}

describe("event store", () => {
  it("enforces contiguous ordering and supports replay", async () => {
    const store = new MemoryEventStore();
    await store.append(event(1));
    await store.append(event(2));
    await expect(store.append(event(4))).rejects.toThrow("Non-contiguous");
    expect((await store.read("session", 1)).map((item) => item.sequence)).toEqual([2]);
  });
});
