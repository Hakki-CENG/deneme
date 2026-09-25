/**
 * Trajectory Recorder
 * Records evaluation trajectory events for analysis and replay.
 */

import type { TrajectoryEvent } from "../tasks/types.js";

export class TrajectoryRecorder {
  private events: TrajectoryEvent[] = [];
  private sequence = 0;

  record(event: { kind: string; timestamp: string; source?: string; payload?: unknown }): void {
    this.events.push({
      ...event,
      sequence: this.sequence++,
    });
  }

  getEvents(): TrajectoryEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
    this.sequence = 0;
  }

  /** Get events of a specific kind */
  getEventsByKind(kind: string): TrajectoryEvent[] {
    return this.events.filter(e => e.kind.includes(kind));
  }

  /** Get event timeline as human-readable string */
  getTimeline(): string {
    return this.events
      .map(e => `[${e.sequence}] ${e.timestamp} ${e.kind}`)
      .join("\n");
  }
}
