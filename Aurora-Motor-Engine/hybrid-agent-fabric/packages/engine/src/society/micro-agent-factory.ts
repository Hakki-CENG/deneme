/**
 * Micro-Agent Factory (master: self-created micro-agents).
 *
 * The society layer ships seeded roles; the swarm layer takes manually added
 * members. What did not exist is the engine noticing a recurring pattern and
 * creating a specialist for it — a role whose capability tags are the
 * capabilities MEASURED on the recurring occurrences, so the specialist is
 * built on evidence, not on a guessed skill list.
 *
 * Honesty note, stated in the code because it belongs here: with the mock
 * provider the "creative" part of self-creation is a deterministic
 * derivation from measured data. A proposal whose evidence carries no
 * capabilities is refused outright — a specialist role with invented tags
 * would be fabrication, not creation.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";
import type { DetectedLoop } from "../cognitive/loop-detection-service.js";

export interface MicroAgentProposal {
  id: string;
  tenantId: string;
  trigger: {
    kind: "repeated-outcome";
    signature: string;
    occurrences: number;
  };
  name: string;
  purpose: string;
  capabilityTags: string[];
  status: "proposed" | "applied" | "rejected";
  roleId?: string;
  evidenceRefs: string[];
  createdAt: string;
  appliedAt?: string;
  rejectedReason?: string;
}

interface FactoryState {
  schemaVersion: 1;
  proposals: MicroAgentProposal[];
}

export interface SocietyRoleLike {
  id: string;
  name: string;
  capabilityTags: string[];
}

export class MicroAgentFactory {
  private readonly store: DurableJsonState<FactoryState>;

  constructor(
    rootPath: string,
    private readonly society: {
      addRole: (input: {
        tenantId: string;
        name: string;
        layer: "micro";
        purpose: string;
        capabilityTags: string[];
      }) => Promise<SocietyRoleLike>;
    },
    private readonly now: () => number = Date.now,
  ) {
    this.store = new DurableJsonState<FactoryState>(
      join(rootPath, "micro-agents.json"),
      () => ({ schemaVersion: 1, proposals: [] }),
      (value) => {
        const state = value as FactoryState;
        return !!state && state.schemaVersion === 1 && Array.isArray(state.proposals);
      },
      "Aurora micro-agent factory",
    );
  }

  async init(): Promise<void> {
    await this.store.read();
  }

  /**
   * Derives a specialist proposal from a detected loop. The capability tags
   * are the union of what the loop's occurrences actually invoked — nothing
   * else. One open proposal per signature: a recurring pattern proposes one
   * specialist, not one per recurrence.
   */
  async proposeFromLoop(tenantId: string, loop: DetectedLoop): Promise<MicroAgentProposal> {
    const capabilities = [...new Set(loop.evidence.flatMap((item) => item.capabilities))].sort();
    if (capabilities.length === 0) {
      throw new Error(
        "Loop evidence carries no invoked capabilities; a specialist role would be built on nothing measured.",
      );
    }
    const at = new Date(this.now()).toISOString();
    const subject = loop.evidence[loop.evidence.length - 1]?.subject ?? loop.signature;

    return await this.store.mutate((state) => {
      const existing = state.proposals.find(
        (item) =>
          item.tenantId === tenantId &&
          item.trigger.signature === loop.signature &&
          (item.status === "proposed" || item.status === "applied"),
      );
      if (existing) return structuredClone(existing);

      const proposal: MicroAgentProposal = {
        id: `micro-${randomUUID()}`,
        tenantId,
        trigger: {
          kind: "repeated-outcome",
          signature: loop.signature,
          occurrences: loop.occurrences,
        },
        name: `Specialist: ${subject}`.slice(0, 200),
        purpose: `Created by the engine after the same outcome recurred ${loop.occurrences} time(s). Specialises in: ${capabilities.join(", ")}. Measured evidence, not a guessed skill list.`,
        capabilityTags: capabilities,
        status: "proposed",
        evidenceRefs: [loop.id],
        createdAt: at,
      };
      state.proposals.push(proposal);
      return structuredClone(proposal);
    });
  }

  /** Applies a proposal: the society gains a real, non-builtin micro role. */
  async apply(tenantId: string, proposalId: string): Promise<MicroAgentProposal> {
    const at = new Date(this.now()).toISOString();
    return await this.store.mutate(async (state) => {
      const proposal = state.proposals.find(
        (item) => item.tenantId === tenantId && item.id === proposalId,
      );
      if (!proposal) throw new Error(`Proposal ${proposalId} not found for this tenant.`);
      if (proposal.status === "applied") return structuredClone(proposal);
      if (proposal.status === "rejected") {
        throw new Error("A rejected proposal cannot be applied; propose again from fresh evidence.");
      }
      const role = await this.society.addRole({
        tenantId,
        name: proposal.name,
        layer: "micro",
        purpose: proposal.purpose,
        capabilityTags: proposal.capabilityTags,
      });
      proposal.status = "applied";
      proposal.roleId = role.id;
      proposal.appliedAt = at;
      return structuredClone(proposal);
    });
  }

  async reject(tenantId: string, proposalId: string, reason: string): Promise<MicroAgentProposal> {
    return await this.store.mutate((state) => {
      const proposal = state.proposals.find(
        (item) => item.tenantId === tenantId && item.id === proposalId,
      );
      if (!proposal) throw new Error(`Proposal ${proposalId} not found for this tenant.`);
      if (proposal.status === "applied") {
        throw new Error("An applied proposal cannot be rejected; retire the role instead.");
      }
      proposal.status = "rejected";
      proposal.rejectedReason = reason.slice(0, 500);
      return structuredClone(proposal);
    });
  }

  async proposals(tenantId: string, status?: MicroAgentProposal["status"]): Promise<MicroAgentProposal[]> {
    const state = await this.store.read();
    return state.proposals
      .filter((item) => item.tenantId === tenantId && (!status || item.status === status))
      .map((item) => structuredClone(item));
  }
}
