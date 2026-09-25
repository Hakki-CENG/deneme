import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HybridAgentEngine } from "../src/engine.js";
import { LearningRolloutManager } from "../src/learning/learning-rollout.js";

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "haf-rollout-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const engine = new HybridAgentEngine({
    homePath,
    kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
    sandboxBackend: "local",
    autoApproveWorkspaceWrites: true,
    allowProcessExecution: true,
    learningTrustedKeys: { release: publicPem },
    model: { provider: "mock" },
  });
  const session = await engine.createSession({ tenantId: "tenant" });
  return { engine, session, privateKey };
}

describe("automatic evaluation and signed canary promotion", () => {
  it("evaluates, verifies signature, observes canary and promotes/rolls back", async () => {
    const { engine, session, privateKey } = await setup();
    await writeFile(join(session.workspacePath, "quality.ok"), "ok");
    const candidate = await engine.learning.propose({
      tenantId: "tenant", sessionId: session.sessionId, kind: "prompt_addendum", scope: "session",
      title: "quality policy", content: "Always verify quality.ok.", evidenceEventIds: ["event-1"],
      expectedOutcome: "quality evidence", createdBy: "agent",
    });
    const release = await engine.learningRollouts.create({
      candidateId: candidate.id,
      evalCommands: ["test -f quality.ok"],
      canaryPercentage: 10,
      minSamples: 2,
      requiredSuccessRate: 1,
    });
    const evaluated = await engine.learningRollouts.runEvaluation(release.id);
    expect(evaluated.status).toBe("awaiting_signature");
    expect(evaluated.evaluation[0]?.exitCode).toBe(0);
    const signature = sign(null, LearningRolloutManager.signaturePayload(evaluated), privateKey).toString("base64");
    expect((await engine.learningRollouts.submitSignature(release.id, { keyId: "release", signature })).status).toBe("canary");
    expect((await engine.learningRollouts.recordOutcome(release.id, true)).status).toBe("canary");
    expect((await engine.learningRollouts.recordOutcome(release.id, true)).status).toBe("promoted");
    expect(await engine.learning.activeArtifacts("tenant", session.sessionId)).toHaveLength(1);
    expect((await engine.learningRollouts.rollback(release.id)).status).toBe("rolled_back");
    expect(await engine.learning.activeArtifacts("tenant", session.sessionId)).toHaveLength(0);
    await engine.shutdown();
  });

  it("does not request a signature when automated evaluation fails", async () => {
    const { engine, session } = await setup();
    const candidate = await engine.learning.propose({
      tenantId: "tenant", sessionId: session.sessionId, kind: "memory", scope: "session",
      title: "bad lesson", content: "A harmless lesson.", evidenceEventIds: ["event-1"],
      expectedOutcome: "test", createdBy: "agent",
    });
    const release = await engine.learningRollouts.create({ candidateId: candidate.id, evalCommands: ["exit 7"] });
    expect((await engine.learningRollouts.runEvaluation(release.id)).status).toBe("evaluation_failed");
    expect((await engine.learning.get(candidate.id)).status).toBe("rejected");
    await engine.shutdown();
  });
});
