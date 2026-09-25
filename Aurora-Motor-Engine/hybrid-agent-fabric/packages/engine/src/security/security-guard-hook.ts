/**
 * Puts the security pipeline in front of every capability the broker executes.
 *
 * M9 armed `SecuritySystemPipeline` — before that it held 0 injection patterns
 * and 0 kill switches — but nothing asked it anything. An external audit put
 * the remaining gap precisely: "M9 solves 'the pipeline is armed'. It does not
 * solve 'the pipeline protects all real agent actions'."
 *
 * ## Why here and not in `execute()`
 *
 * Wiring a check into `engine.execute()` would guard the loop's own bookkeeping
 * and miss everything else: a session started over HTTP, an MCP tool call, a
 * plugin. Side effects do not happen in `execute()`, they happen when the
 * broker runs a capability, and every one of those paths converges on
 * `CapabilityBroker.execute()` — which already invokes a `pre_capability`
 * guard before policy, approval and the effect journal.
 *
 * So this registers there. One seam, all callers.
 *
 * ## What it deliberately does NOT do
 *
 * It does not re-implement policy, approvals or trust levels: the broker's
 * PolicyEngine already decides those, and duplicating that logic here would
 * create two answers to the same question with no rule for which wins.
 *
 * It checks the two things the broker cannot see:
 *
 *  1. **Kill switch.** A global stop must stop everything, including calls the
 *     policy engine would happily allow. Without this, triggering a kill
 *     switch changed a number in `getStats()` and nothing else.
 *  2. **Prompt injection in the arguments.** The broker validates argument
 *     *shape*; it has no view on a string carrying "ignore all previous
 *     instructions".
 *
 * ## Why only prompt injection, and not the payload patterns
 *
 * Measured, not assumed: scanning arguments with every default pattern broke
 * 5 passing tests. `Command Injection` is `/[;&|`$]/`, so it rejected the
 * shell capability for containing `&&` — the thing a shell capability exists
 * to accept — and `Path Traversal` rejected a patch whose diff mentioned
 * `../outside.txt`, replacing the precise message "escapes the assigned
 * workspace" with a vaguer one.
 *
 * Those payload patterns are about a string reaching an interpreter, and the
 * capability that owns the interpreter already escapes it and checks its own
 * boundary. A central blanket check there subtracts: it breaks working calls
 * and it degrades a specific error into a generic one.
 *
 * Prompt injection is the opposite case. The interpreter is the model, no
 * downstream escaping helps, and no capability is supposed to receive "ignore
 * all previous instructions" as data. That is what this blocks.
 */

import type { HookBus } from "../plugins/hook-bus.js";
import { UntrustedContentGate } from "./untrusted-content-gate.js";
import type { SecuritySystemPipeline } from "./security-system.js";

const PLUGIN_ID = "aurora.security";

/** Depth-limited walk: arguments are JSON, but a hostile one can be deep. */
function collectStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 64) return out;
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, depth + 1, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, depth + 1, out);
  }
  return out;
}

export interface SecurityGuardOptions {
  /**
   * Scan capability arguments for prompt-injection patterns.
   *
   * Default true. Turning it off leaves the kill switch active, because a
   * global stop is not an opinion about content.
   */
  readonly scanArguments?: boolean | undefined;
}

/**
 * Registers the guard. Returns an unsubscribe function.
 *
 * Idempotent per HookBus: registering twice would run the same check twice and
 * produce duplicate denials, so callers should hold the returned handle.
 */
export function registerSecurityGuard(
  hooks: HookBus,
  pipeline: SecuritySystemPipeline,
  options: SecurityGuardOptions = {},
): () => void {
  const scanArguments = options.scanArguments ?? true;

  const unregisterGuard = hooks.register({
    pluginId: PLUGIN_ID,
    hook: "pre_capability",
    kind: "guard",
    callback: async (payload: unknown) => {
      const input = payload as {
        capability?: { id?: string };
        arguments?: unknown;
      };

      // 1. Kill switch: stops everything, including safe-looking calls.
      if (pipeline.killSwitchManager.isAnyTriggered()) {
        return {
          decision: "deny" as const,
          reason:
            "A kill switch is triggered; no capability may execute until it is reset.",
        };
      }

      if (!scanArguments) return { decision: "allow" as const };

      // 2. Prompt injection in the arguments the capability was handed.
      //    "prompt" only — see the note above on why the payload patterns
      //    belong to the capability that owns the interpreter.
      const strings = collectStrings(input.arguments);
      if (strings.length === 0) return { decision: "allow" as const };

      const detections = pipeline.injectionDetector.detect(
        strings.join("\n"),
        "prompt",
      );
      if (detections.length === 0) return { decision: "allow" as const };

      // Name what was found. A bare "denied" teaches the caller nothing and
      // makes a false positive impossible to diagnose.
      const named = detections.map((item) => item.pattern).join(", ");
      pipeline.killSwitchManager.addSecurityEvent({
        type: "injection_detected",
        severity: "critical",
        details: `Injection in arguments to ${input.capability?.id ?? "unknown"}: ${named}`,
      });

      return {
        decision: "deny" as const,
        reason: `Injection detected in capability arguments: ${named}`,
      };
    },
    timeoutMs: 2000,
  });

  // P2.38, the other half: results. The guard above decides whether a call
  // may run; this transform decides what the model gets to see of the output.
  // Fetched pages, PDF text, exec stdout, research snippets — all of it
  // crosses this seam on the way back into context, so injected instructions
  // in any of them arrive fenced and labelled instead of looking like the
  // agent's own instructions. Benign output is returned byte-identical.
  const gate = new UntrustedContentGate(pipeline);
  const unregisterTransform = hooks.register({
    pluginId: PLUGIN_ID,
    hook: "tool_result",
    kind: "transform",
    callback: async (payload: unknown) => {
      const input = payload as { capabilityId?: string; result?: unknown };
      if (input?.result === undefined || input.result === null) return undefined;
      const screened = gate.screenValue(input.result, `tool-result:${input.capabilityId ?? "unknown"}`);
      return { capabilityId: input.capabilityId, result: screened.value };
    },
    timeoutMs: 2000,
  });

  return () => {
    unregisterGuard();
    unregisterTransform();
  };
}
