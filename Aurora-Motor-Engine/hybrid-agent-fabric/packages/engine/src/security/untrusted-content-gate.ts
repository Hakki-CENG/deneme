import type { SecuritySystemPipeline } from "./security-system.js";

/**
 * P2.38 — the indirect-injection half of prompt injection defence.
 *
 * The existing pipeline already guards the two surfaces where a *decision* is
 * made from outside text: task goals (`screenInput`) and capability arguments
 * (the `pre_capability` security guard). What it did not cover is the third
 * surface: content that arrives as *data* — fetched web pages, PDF text,
 * tool output, research snippets — and then travels into the model's context
 * looking exactly like instructions.
 *
 * ## Why fence instead of block
 *
 * Blocking content outright would make the agent unable to ever *discuss*
 * injected material: a security analyst asking "what does this page try to
 * make you do?" needs the page, verbatim. A blanket block is a screening layer
 * that fails closed on the legitimate use case for knowing about injections.
 *
 * So detected content is wrapped in an explicit delimiter that names the
 * source and the detections, and the original text is preserved verbatim
 * inside the fence. The model can read it, quote it and reason about it; what
 * it can no longer do is mistake it for instructions, because the fence says
 * what it is and where it came from.
 *
 * ## Why only prompt-target patterns
 *
 * Same measured reasoning as the `pre_capability` guard: the payload patterns
 * (`SQL Injection`, `Command Injection`, `Path Traversal`, `Script Injection`)
 * match strings a tool legitimately carries — a shell capability's stdout, a
 * patch diff that mentions `../outside.txt`. Fencing those would corrupt
 * working data and teach callers to ignore fences. Only the patterns whose
 * interpreter is the *model* — instruction override, system-prompt
 * exfiltration, role hijack, safety bypass, credential exfiltration — are
 * fences here.
 *
 * ## Kill switch
 *
 * A triggered kill switch quarantines content entirely: nothing is screened
 * as safe, and the replacement text says why. The fence is a treatment for
 * detected injections; the kill switch is the global stop.
 */

const FENCE_OPEN_PREFIX = "<UNTRUSTED_CONTENT";
const FENCE_CLOSE = "</UNTRUSTED_CONTENT>";

export interface UntrustedContentVerdict {
  /** Prompt-target injection patterns found in the content. */
  detections: Array<{ pattern: string; severity: string; match: string }>;
  /**
   * The content to hand downstream: fenced when detections exist (or the kill
   * switch is triggered), byte-identical to the input otherwise.
   */
  content: string;
  fenced: boolean;
  /** True when the kill switch quarantined the content instead of fencing it. */
  quarantined: boolean;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class UntrustedContentGate {
  constructor(private readonly pipeline: SecuritySystemPipeline) {}

  screen(content: string, source: string): UntrustedContentVerdict {
    if (this.pipeline.killSwitchManager.isAnyTriggered()) {
      return {
        detections: [],
        content: `[quarantined: kill switch triggered; content from ${source} was not passed through]`,
        fenced: true,
        quarantined: true,
      };
    }
    const detections = this.pipeline.injectionDetector.detect(content, "prompt");
    if (detections.length === 0) {
      return { detections: [], content, fenced: false, quarantined: false };
    }
    const names = [...new Set(detections.map((detection) => detection.pattern))].join(", ");
    this.pipeline.killSwitchManager.addSecurityEvent({
      type: "injection_detected",
      severity: "critical",
      details: `Injection fenced in untrusted content from ${source}: ${names}`,
    });
    const fenced = `${FENCE_OPEN_PREFIX} source="${escapeAttribute(source)}" warning="${escapeAttribute(names)}">\n${content}\n${FENCE_CLOSE}`;
    return { detections, content: fenced, fenced: true, quarantined: false };
  }

  /**
   * Screens every string inside a JSON-serializable value, fencing the ones
   * that carry prompt-injection patterns. The walk is depth- and count-bounded
   * so a hostile nested payload cannot turn screening into a resource attack.
   * Values that are not JSON-safe are returned unchanged.
   */
  screenValue<T>(value: T, source: string): { value: T; detections: Array<{ pattern: string; severity: string; match: string }>; anyFenced: boolean } {
    const detections: Array<{ pattern: string; severity: string; match: string }> = [];
    let anyFenced = false;
    const walk = (node: unknown, depth: number, budget: { left: number }): unknown => {
      if (depth > 8 || budget.left <= 0) return node;
      if (typeof node === "string") {
        budget.left -= 1;
        const verdict = this.screen(node, source);
        if (verdict.fenced) {
          anyFenced = true;
          detections.push(...verdict.detections);
          return verdict.content;
        }
        return node;
      }
      if (Array.isArray(node)) {
        return node.map((item) => walk(item, depth + 1, budget));
      }
      if (node !== null && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(node)) {
          out[key] = walk(item, depth + 1, budget);
        }
        return out;
      }
      return node;
    };
    const screened = walk(value, 0, { left: 128 }) as T;
    return { value: screened, detections, anyFenced };
  }
}
