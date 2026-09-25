import type { JsonValue, PolicyDecision } from "../types.js";
import type { PolicyEngine, PolicyInput } from "./policy-engine.js";

export interface OpaPolicyOptions {
  endpoint: string;
  bearerToken?: string;
  timeoutMs?: number;
}

function redactPolicyValue(value: JsonValue, key = ""): JsonValue {
  if (/token|secret|password|authorization|cookie|credential|private.?key/i.test(key)) return "<redacted>";
  if (Array.isArray(value)) return value.map((item) => redactPolicyValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactPolicyValue(child, childKey)]));
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}<truncated>`;
  return value;
}

export class OpaPolicyEngine implements PolicyEngine {
  private readonly endpoint: string;
  constructor(private readonly options: OpaPolicyOptions) {
    const url = new URL(options.endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("OPA endpoint must use HTTP(S).");
    this.endpoint = url.toString();
  }

  async decide(input: PolicyInput): Promise<PolicyDecision> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 3000);
    timer.unref();
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {}),
        },
        body: JSON.stringify({
          input: {
            tenantId: input.context.tenantId,
            sessionId: input.context.sessionId,
            source: input.context.source,
            capability: input.descriptor,
            arguments: redactPolicyValue(input.arguments),
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) return this.closed(`opa_http_${response.status}`);
      const body = await response.json() as { result?: unknown };
      const result = body.result as Partial<PolicyDecision> | undefined;
      if (!result || !["allow", "deny", "require_approval"].includes(String(result.decision))) {
        return this.closed("opa_invalid_result");
      }
      return {
        decision: result.decision as PolicyDecision["decision"],
        reasonCode: typeof result.reasonCode === "string" ? result.reasonCode : "opa_decision",
        message: typeof result.message === "string" ? result.message : "Decision returned by organization policy.",
        ...(result.approvalScope && ["once", "session", "resource"].includes(result.approvalScope)
          ? { approvalScope: result.approvalScope }
          : {}),
        ...(result.constraints && typeof result.constraints === "object" ? { constraints: result.constraints } : {}),
      };
    } catch (error) {
      return this.closed(error instanceof DOMException && error.name === "AbortError" ? "opa_timeout" : "opa_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  private closed(reasonCode: string): PolicyDecision {
    return {
      decision: "deny",
      reasonCode,
      message: "Organization policy could not produce a valid decision; execution failed closed.",
    };
  }
}

export class LayeredPolicyEngine implements PolicyEngine {
  constructor(private readonly layers: PolicyEngine[]) {
    if (!layers.length) throw new Error("Layered policy engine requires at least one layer.");
  }

  async decide(input: PolicyInput): Promise<PolicyDecision> {
    let strongest: PolicyDecision = { decision: "allow", reasonCode: "all_layers_allow", message: "All policy layers allow this action." };
    for (const layer of this.layers) {
      const decision = await layer.decide(input);
      if (decision.decision === "deny") return decision;
      if (decision.decision === "require_approval") strongest = decision;
    }
    return strongest;
  }
}
