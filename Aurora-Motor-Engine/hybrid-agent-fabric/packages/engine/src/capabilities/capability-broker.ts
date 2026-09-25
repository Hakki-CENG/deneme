import type {
  Capability,
  CapabilityContext,
  CapabilityDescriptor,
  JsonValue,
  PolicyDecision,
} from "../types.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import { ApprovalService } from "../policy/approval-service.js";
import type { EffectJournalLike } from "../persistence/effect-journal.js";
import type { HookBus } from "../plugins/hook-bus.js";

/** Which check refused a capability. */
export type CapabilityDenialSource = "security-guard" | "policy" | "approval";

/**
 * A capability was refused by a check that runs before it.
 *
 * Every refusal here used to be a plain `Error`, and the wording was the only
 * thing distinguishing them. That mattered in two places at once:
 *
 * - **the failure taxonomy.** It classifies by pattern, and its
 *   `security_block` rules are `/blocked by policy/i`, `/kill switch/i`,
 *   `/forbidden by guard/i`. The guard's own message said "a security plugin
 *   denied X", which matched none of them, so a security refusal was classified
 *   as an unknown failure and the loop was free to pick a recovery strategy for
 *   it. Refusing something and then trying to work around the refusal is the
 *   opposite of fail-closed.
 * - **an HTTP caller.** It could not tell "you are not allowed" from "it broke".
 *
 * The messages below therefore use the canonical wording the taxonomy already
 * recognises, and `source` carries the same fact as data so nothing has to parse
 * prose to learn it.
 */
export class CapabilityDeniedError extends Error {
  constructor(
    readonly capabilityId: string,
    readonly source: CapabilityDenialSource,
    reason: string,
    readonly details?: Record<string, unknown> | undefined,
  ) {
    super(reason);
    this.name = "CapabilityDeniedError";
  }
}

export interface CapabilityLifecycleEvent {
  phase: "policy" | "approval" | "started" | "finished";
  descriptor: CapabilityDescriptor;
  context: CapabilityContext;
  decision?: PolicyDecision;
  status?: "ok" | "error" | "blocked";
  durationMs?: number;
  error?: string;
}

export type CapabilityLifecycleListener = (event: CapabilityLifecycleEvent) => void | Promise<void>;

export class CapabilityBroker {
  private readonly capabilities = new Map<string, Capability>();
  private readonly listeners = new Set<CapabilityLifecycleListener>();

  constructor(
    private readonly policy: PolicyEngine,
    readonly approvals: ApprovalService,
    private readonly effects: EffectJournalLike,
    private readonly hooks?: HookBus,
  ) {}

  register(capability: Capability): void {
    if (this.capabilities.has(capability.descriptor.id)) {
      throw new Error(`Capability ${capability.descriptor.id} is already registered.`);
    }
    this.capabilities.set(capability.descriptor.id, capability);
  }

  unregister(id: string): boolean {
    return this.capabilities.delete(id);
  }

  list(): CapabilityDescriptor[] {
    return [...this.capabilities.values()].map(({ descriptor }) => descriptor);
  }

  subscribe(listener: CapabilityLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(id: string, rawInput: unknown, context: CapabilityContext): Promise<JsonValue> {
    if (context.allowedCapabilityIds && !context.allowedCapabilityIds.includes(id)) {
      throw new Error(`Capability ${id} is not allowed by this session's agent profile.`);
    }
    const capability = this.capabilities.get(id);
    if (!capability) throw new Error(`Unknown capability: ${id}`);
    const input = capability.validate(rawInput);
    const guard = await this.hooks?.invokeGuard("pre_capability", {
      capability: capability.descriptor,
      arguments: input,
      context: {
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        turnId: context.turnId,
        source: context.source,
      },
    });
    if (guard?.decision === "deny") {
      // Canonical wording on purpose: "forbidden by guard" is one of the
      // patterns `classifyFailure` recognises as a security block.
      throw new CapabilityDeniedError(
        id,
        "security-guard",
        `Capability ${id} is forbidden by guard: ${guard.reason ?? "a registered security guard refused it."}`,
        { reason: guard.reason },
      );
    }
    const decision = await this.policy.decide({ descriptor: capability.descriptor, arguments: input, context });
    await this.emit({ phase: "policy", descriptor: capability.descriptor, context, decision });

    if (decision.decision === "deny") {
      await this.emit({ phase: "finished", descriptor: capability.descriptor, context, status: "blocked", error: decision.message });
      throw new CapabilityDeniedError(
        id,
        "policy",
        `Capability ${id} blocked by policy: ${decision.message}`,
        { reasonCode: decision.reasonCode },
      );
    }
    if (decision.decision === "require_approval") {
      await this.emit({ phase: "approval", descriptor: capability.descriptor, context, decision });
      const approved = await this.approvals.request(capability.descriptor, input, context, decision.message);
      if (!approved) {
        await this.emit({ phase: "finished", descriptor: capability.descriptor, context, status: "blocked", error: "Approval denied or expired." });
        throw new CapabilityDeniedError(
          id,
          "approval",
          `Capability ${id} was not permitted: approval was denied or expired.`,
          { approvalScope: decision.approvalScope },
        );
      }
    }

    const start = Date.now();
    await this.emit({ phase: "started", descriptor: capability.descriptor, context });
    // P1.33: the capability's rollback, if it declares one. Late bound so the
    // happy path stays a straight line; the failure path compensates.
    let rollbackNote = "";
    try {
      const operation = () => capability.execute(input, context);
      const result = capability.descriptor.sideEffect
        ? await this.effects.execute(context.idempotencyKey, operation, context.tenantId)
        : await operation();
      // P1.33 output contract: a capability that promised an output shape must
      // keep it. Violations fail the call instead of reaching the caller — a
      // tool that changes its mind about what it returns is a fault, not a
      // quirk the caller should absorb.
      if (capability.validateOutput) {
        try {
          capability.validateOutput(result);
        } catch (error) {
          throw new Error(`Capability ${id} violated its declared output schema: ${(error as Error).message}`);
        }
      }
      // P1.33 verifier: structural validity is not effect. When a capability
      // declares how to check its own effect, the broker holds it to that.
      if (capability.verify) {
        const verdict = await capability.verify(result, input, context);
        if (!verdict.ok) {
          throw new Error(`Capability ${id} failed post-execution verification${verdict.reason ? `: ${verdict.reason}` : "."}`);
        }
      }
      await this.emit({ phase: "finished", descriptor: capability.descriptor, context, status: "ok", durationMs: Date.now() - start });
      this.hooks?.emitObserver("post_capability", {
        capabilityId: capability.descriptor.id,
        status: "ok",
        durationMs: Date.now() - start,
        sessionId: context.sessionId,
        turnId: context.turnId,
      });
      // P2.38: the result is what travels back into the model's context as a
      // tool message. A transform hook here is the one seam every caller
      // crosses — agent turns, MCP, plugins — so screening for indirect
      // injection happens once, at the boundary, instead of per consumer.
      // Validation and verification above deliberately ran on the RAW result:
      // a capability must be held to its own contract before its output is
      // re-labelled for the model.
      if (this.hooks) {
        const transformed = await this.hooks.invokeTransform("tool_result", { capabilityId: id, result });
        return transformed.result;
      }
      return result;
    } catch (error) {
      // P1.33 rollback: execution failed — possibly after partially taking
      // effect. If the capability declared compensation, attempt it now, and
      // record what happened to it. A rollback that fails or cannot complete
      // is reported as such; it never masks the original error.
      if (capability.rollback) {
        try {
          const rolled = await capability.rollback(input, context);
          rollbackNote = rolled.rolledBack
            ? "; rolled back"
            : `; rollback not completed${rolled.detail ? `: ${rolled.detail}` : ""}`;
        } catch (rollbackError) {
          rollbackNote = `; rollback errored: ${(rollbackError as Error).message}`;
        }
      }
      await this.emit({
        phase: "finished",
        descriptor: capability.descriptor,
        context,
        status: "error",
        durationMs: Date.now() - start,
        error: `${error instanceof Error ? error.message : String(error)}${rollbackNote}`,
      });
      this.hooks?.emitObserver("post_capability", {
        capabilityId: capability.descriptor.id,
        status: "error",
        durationMs: Date.now() - start,
        errorClass: error instanceof Error ? error.name : "unknown",
        sessionId: context.sessionId,
        turnId: context.turnId,
      });
      throw error;
    }
  }

  private async emit(event: CapabilityLifecycleEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await Promise.race([
          listener(event),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            timer.unref();
          }),
        ]);
      } catch {
        // Lifecycle observers are fail-open and bounded.
      }
    }
  }
}
