import type { CapabilityContext, CapabilityDescriptor, JsonValue, PolicyDecision } from "../types.js";

export interface PolicyInput {
  descriptor: CapabilityDescriptor;
  arguments: Record<string, JsonValue>;
  context: CapabilityContext;
}

export interface PolicyEngine {
  decide(input: PolicyInput): Promise<PolicyDecision>;
}

export interface DefaultPolicyOptions {
  autoApproveWorkspaceWrites?: boolean;
  allowLocalProcess?: boolean;
  deniedCapabilities?: string[];
}

export class DefaultPolicyEngine implements PolicyEngine {
  private readonly denied: Set<string>;

  constructor(private readonly options: DefaultPolicyOptions = {}) {
    this.denied = new Set(options.deniedCapabilities ?? []);
  }

  async decide({ descriptor, context }: PolicyInput): Promise<PolicyDecision> {
    if (this.denied.has(descriptor.id)) {
      return { decision: "deny", reasonCode: "capability_denied", message: `${descriptor.id} is denied by policy.` };
    }

    if (context.source === "webhook" && !["pure", "workspace_read"].includes(descriptor.risk)) {
      return {
        decision: "deny",
        reasonCode: "untrusted_webhook_source",
        message: "Untrusted webhook sessions are restricted to pure and read-only capabilities.",
      };
    }

    switch (descriptor.risk) {
      case "pure":
      case "workspace_read":
        return { decision: "allow", reasonCode: "low_risk", message: "Allowed by the low-risk policy." };
      case "workspace_write":
        return this.options.autoApproveWorkspaceWrites
          ? { decision: "allow", reasonCode: "workspace_write_enabled", message: "Workspace writes are enabled." }
          : {
              decision: "require_approval",
              reasonCode: "workspace_mutation",
              message: "This action modifies the assigned workspace.",
              approvalScope: "session",
            };
      case "process":
        return this.options.allowLocalProcess
          ? { decision: "allow", reasonCode: "process_enabled", message: "Process execution is enabled for this runtime." }
          : {
              decision: "require_approval",
              reasonCode: "process_execution",
              message: "This action executes a process in the sandbox.",
              approvalScope: "once",
            };
      case "network":
        return {
          decision: "require_approval",
          reasonCode: "network_access",
          message: "This action accesses the network.",
          approvalScope: "resource",
        };
      case "external_side_effect":
      case "privileged":
        return {
          decision: "require_approval",
          reasonCode: descriptor.risk,
          message: "This action creates an external or privileged side effect.",
          approvalScope: "once",
        };
    }
  }
}
