/**
 * Publishes a verified synthesised capability to the real CapabilityBroker.
 *
 * This is the last link of the acquisition chain. Before it, `acquire()`
 * returned `{ acquired: true, capabilityId }` and the implementation stayed
 * inside the synthesis pipeline's own map — so "a capability was generated"
 * and "the agent can use it" were different statements, and only the first was
 * true. The loop would retry the original task against an inventory that had
 * never heard of the thing just built.
 *
 * ## Why this does not violate specification item 14
 *
 * Item 14 forbids loading generated code into the core process: no dynamic
 * import, no `new Function`, no `require`. This adapter does not execute the
 * generated source. It registers a descriptor whose `execute()` **delegates
 * back to the sandbox** (`pipeline.testInSandbox`), which is the same isolated
 * VM context, resource limits and timeout the verification steps used.
 *
 * The code never leaves quarantine. What changes is that the broker can now
 * route a call to it, under the broker's own policy, approval and effect
 * journalling — which is exactly the supervision an acquired capability
 * should be under, and more than the synthesis pipeline applies on its own.
 */

import type { CapabilitySynthesisPipeline } from "../capabilities/capability-synthesis.js";
import type { Capability, CapabilityDescriptor, JsonValue } from "../types.js";

/** The subset of CapabilityBroker this adapter needs. */
export interface CapabilityRegistrar {
  register(capability: Capability): void;
  list(): CapabilityDescriptor[];
}

export interface PublishInput {
  /** Gap name, e.g. `visual_diff`. Becomes the broker-facing id. */
  readonly name: string;
  readonly description: string;
  /** Id inside the synthesis pipeline; the sandbox handle. */
  readonly synthesisedId: string;
  readonly pipeline: Pick<CapabilitySynthesisPipeline, "testInSandbox">;
}

export interface PublishResult {
  readonly published: boolean;
  readonly capabilityId: string;
  readonly reason: string;
}

/**
 * Broker ids are namespaced so nothing generated can shadow a core capability.
 *
 * Without this, a synthesised capability called `fs.write` would take the name
 * of the real one for any caller resolving by id.
 */
export function acquiredCapabilityId(name: string): string {
  return `acquired.${name}`;
}

/**
 * Registers a verified capability with the broker.
 *
 * Returns `published: false` with a reason rather than throwing: a capability
 * that was built and verified but could not be published is a degraded
 * outcome, not a failed task, and the caller needs to be able to say which
 * happened.
 */
export function publishAcquiredCapability(
  registrar: CapabilityRegistrar,
  input: PublishInput,
): PublishResult {
  const id = acquiredCapabilityId(input.name);

  if (registrar.list().some((descriptor) => descriptor.id === id)) {
    // Not an error: the same gap being closed twice in one process is normal.
    // Re-registering would throw inside the broker.
    return { published: false, capabilityId: id, reason: `${id} is already registered.` };
  }

  const descriptor: CapabilityDescriptor = {
    id,
    version: "0.1.0",
    description: `${input.description} (synthesised, runs in sandbox)`,
    // `pure` is the accurate category, not a lenient one: CapabilityRisk
    // describes WHAT a capability can reach, not how much it is trusted. This
    // code runs in a VM context with no filesystem, no network and no process
    // access — measured in M6, where require('node:fs') failed as "require is
    // not defined" and an infinite loop was killed by the timeout.
    //
    // Claiming a higher category would be inaccurate in the other direction:
    // it would tell the policy engine to guard against reaches this capability
    // cannot make, while saying nothing about the real concern, which is that
    // the implementation is young. That belongs in the description and in the
    // `acquired.` namespace, both of which are visible to anything listing the
    // broker.
    risk: "pure",
    sideEffect: false,
    inputSchema: { type: "object" } as JsonValue,
    source: "skill",
  };

  const capability: Capability = {
    descriptor,
    validate(raw: unknown): Record<string, JsonValue> {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`${id} expects an object input.`);
      }
      return raw as Record<string, JsonValue>;
    },
    async execute(args: Record<string, JsonValue>): Promise<JsonValue> {
      // The generated code runs here, in the sandbox, never in this process.
      const result = await input.pipeline.testInSandbox(input.synthesisedId, args);
      if (!result.success) {
        throw new Error(result.error ?? `${id} failed in the sandbox.`);
      }
      return (result.output ?? null) as JsonValue;
    },
  };

  registrar.register(capability);
  return { published: true, capabilityId: id, reason: `${id} registered from sandbox.` };
}
