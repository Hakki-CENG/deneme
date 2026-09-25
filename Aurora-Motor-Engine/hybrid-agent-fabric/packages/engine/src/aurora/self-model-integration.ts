import type { EventBus } from "./event-bus.js";
import type { SelfModelService } from "./self-model-service.js";

/**
 * P2.14 reflection cycles wired to real engine events: after significant
 * tasks (completion), after failure, and after milestones. The periodic
 * reflection already runs through the autopilot's reflection cadence — this
 * integration adds the event-driven triggers so reflection also happens at
 * the moments the architecture names. Handlers are fail-open: reflection must
 * never fail the task it reflects on.
 */
export class SelfModelIntegration {
  private readonly subscriptionIds: string[] = [];

  constructor(
    private readonly eventBus: EventBus,
    private readonly selfModel: SelfModelService,
  ) {}

  init(): void {
    this.subscriptionIds.push(
      this.eventBus.subscribe("task.completed", async (event) => {
        await this.guard(async () => {
          const tenantId = this.tenantOf(event.payload);
          if (!tenantId) return;
          const goal = this.textOf(event.payload["goal"]);
          // A completed task with a real goal is a milestone worth reflecting
          // on; a completion without one still counts as a capability outcome
          // observation, but no reflection is forced.
          await this.selfModel.reflect(tenantId, goal ? "milestone" : "task");
          if (goal) await this.selfModel.recordStrategyOutcome(tenantId, "direct", true, goal.slice(0, 200));
        });
      }),
      this.eventBus.subscribe("task.failed", async (event) => {
        await this.guard(async () => {
          const tenantId = this.tenantOf(event.payload);
          if (!tenantId) return;
          const goal = this.textOf(event.payload["goal"]);
          await this.selfModel.reflect(tenantId, "failure");
          if (goal) {
            await this.selfModel.recordFailure(
              tenantId,
              goal.slice(0, 2000),
              "task-failure",
              "unknown (no root-cause analysis ran for this event)",
              "direct",
              "A task failed; the root cause was not automatically isolated. Treat the lesson as 'needs investigation', not a conclusion.",
            );
            await this.selfModel.recordStrategyOutcome(tenantId, "direct", false, goal.slice(0, 200));
          }
        });
      }),
    );
  }

  dispose(): void {
    for (const id of this.subscriptionIds) this.eventBus.unsubscribe(id);
    this.subscriptionIds.length = 0;
  }

  private tenantOf(payload: Record<string, unknown>): string | undefined {
    const tenantId = payload["tenantId"];
    return typeof tenantId === "string" && tenantId.trim() ? tenantId : undefined;
  }

  private textOf(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  private async guard(handler: () => Promise<void>): Promise<void> {
    try {
      await handler();
    } catch {
      // Reflection must never fail the task it reflects on.
    }
  }
}
