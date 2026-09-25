/**
 * D7 (P1.20): procedural memory — a successful trajectory becomes a procedure.
 *
 * What was measured before this existed. `ExperienceCompilerService` contained
 * the whole machine: `recordExperience` (steps with tool/input/output/duration),
 * `compileSkills` (group by tags, ≥3 successes, extract the repeated
 * action:tool sequence), `recordSkillOutcome`, `promoteSkill`, `findSkill` —
 * durable, staged, tenant-scoped. And `recordExperience` had ZERO callers in
 * `src`. No real task trajectory ever reached the compiler, so no procedure was
 * ever compiled from real work: the machine was present and idle, and D7's
 * "trajectory → skill" arrow existed only as unused code.
 *
 * The fix is deliberately a bridge, not a second system: the execution loop's
 * learn hook now records every finished task (B4's plan-step evidence is the
 * "actual tool sequence"; invoked capabilities are the tags), and compilation
 * runs on the same hook, bounded by the per-tenant experience cap.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ExperienceCompilerService, type TaskTrajectory } from "../src/aurora/experience-compiler.js";
import { HybridAgentEngine } from "../src/engine.js";

async function compiler(options?: { maxExperiencesPerTenant?: number }) {
  const root = await mkdtemp(join(tmpdir(), "haf-proc-"));
  return new ExperienceCompilerService(root, options);
}

function trajectory(partial: Partial<TaskTrajectory> & { tenantId?: string }): TaskTrajectory {
  return {
    tenantId: partial.tenantId ?? "t",
    goal: "Deploy the service to staging",
    status: "succeeded",
    durationMs: 12_000,
    tokens: 4000,
    summary: "Deployed and verified.",
    verification: "Verified by smoke-test: 200 OK",
    steps: [
      { description: "build the image", status: "succeeded", evidence: { actor: "tool:docker", detail: "image built", durationMs: 5000 } },
      { description: "push to registry", status: "succeeded", evidence: { actor: "tool:docker", detail: "pushed", durationMs: 4000 } },
      { description: "switch the traffic", status: "not_implemented" },
    ],
    invokedCapabilities: ["docker.build", "docker.push"],
    ...partial,
  };
}

describe("a finished task becomes an experience (D7)", () => {
  it("records the steps that actually ran, with their tools, tags and verification", async () => {
    const service = await compiler();
    const experience = await service.recordTaskExperience(trajectory({}));

    expect(experience.outcome).toBe("success");
    // Only evidence-carrying steps are the sequence — the untouched step is
    // not part of what happened.
    expect(experience.steps.map((step) => `${step.action}/${step.tool}`)).toEqual([
      "build the image/tool:docker",
      "push to registry/tool:docker",
    ]);
    expect(experience.tags).toEqual(["docker.build", "docker.push"]);
    expect(experience.verification).toBe("Verified by smoke-test: 200 OK");
    expect((await service.getExperiences("t")).length).toBe(1);
  });

  it("maps unverified to partial — procedures compile from confirmed work only", async () => {
    const service = await compiler();
    const experience = await service.recordTaskExperience(trajectory({ status: "unverified" }));
    expect(experience.outcome).toBe("partial");
  });

  it("falls back to invoked capabilities when no plan step carries evidence", async () => {
    const service = await compiler();
    const experience = await service.recordTaskExperience(
      trajectory({ steps: [{ description: "x", status: "not_implemented" }] }),
    );
    expect(experience.steps.map((step) => step.tool)).toEqual(["docker.build", "docker.push"]);
    expect(experience.steps.every((step) => step.action === "invoke")).toBe(true);
  });

  it("invents nothing when the task ran neither attributed steps nor capabilities", async () => {
    const service = await compiler();
    const experience = await service.recordTaskExperience(
      trajectory({ steps: [], invokedCapabilities: [] }),
    );
    expect(experience.steps).toEqual([]);
    expect(experience.tags).toEqual([]);
  });
});

describe("three confirmed trajectories compile into a candidate skill (D7)", () => {
  it("extracts the repeated action:tool sequence as a staged procedure", async () => {
    const service = await compiler();
    for (let index = 0; index < 3; index += 1) {
      await service.recordTaskExperience(trajectory({ tenantId: "t" }));
    }
    // Compilation is the compiler's own stage, run by the engine's learn hook
    // in production; this is the unit, so it is invoked here.
    await service.compileSkills("t");

    const skills = await service.getSkills("t");
    expect(skills.length).toBe(1);
    const skill = skills[0]!;
    expect(skill.stage).toBe("candidate");
    expect(skill.requiredCapabilities).toEqual(["docker.build", "docker.push"]);
    // The procedure is the shared sequence, ordered by frequency.
    expect(skill.procedure.map((step) => `${step.action}:${step.tool}`)).toEqual([
      "build the image:tool:docker",
      "push to registry:tool:docker",
    ]);
    expect(skill.sourceExperienceIds.length).toBe(3);
  });

  it("does not compile procedures from unconfirmed work", async () => {
    const service = await compiler();
    for (let index = 0; index < 3; index += 1) {
      await service.recordTaskExperience(trajectory({ status: "unverified" }));
    }
    await service.compileSkills("t");
    expect((await service.getSkills("t")).length).toBe(0);
  });

  it("promotes a skill and finds it again by the tools it uses", async () => {
    const service = await compiler();
    for (let index = 0; index < 3; index += 1) {
      await service.recordTaskExperience(trajectory({}));
    }
    await service.compileSkills("t");
    const [skill] = await service.getSkills("t");
    await service.promoteSkill(skill!.id, "approved");

    const found = await service.findSkill("t", ["docker.push"]);
    expect(found?.id).toBe(skill!.id);
    // A skill another tenant compiled is not this tenant's.
    expect(await service.findSkill("other", ["docker.push"])).toBeUndefined();
  });
});

describe("the experience pool is bounded (D7)", () => {
  it("keeps the newest experiences per tenant and drops the oldest", async () => {
    const service = await compiler({ maxExperiencesPerTenant: 3 });
    for (let index = 0; index < 5; index += 1) {
      await service.recordTaskExperience(trajectory({ goal: `task ${index}` }));
    }
    const experiences = await service.getExperiences("t");
    expect(experiences.length).toBe(3);
    // The two OLDEST are gone; the newest three survive. Assert membership
    // rather than order — all five can share a createdAt millisecond, which
    // makes the newest-first sort tie arbitrarily, but the eviction itself is
    // FIFO by insertion and therefore deterministic.
    const descriptions = experiences.map((e) => e.taskDescription);
    expect(descriptions).toContain("task 4");
    expect(descriptions).toContain("task 3");
    expect(descriptions).toContain("task 2");
    expect(descriptions).not.toContain("task 0");
    expect(descriptions).not.toContain("task 1");
  });
});

describe("the real execution path feeds the compiler (wiring)", () => {
  it("engine.execute records an experience for the task, whatever its outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-proc-engine-"));
    const engine = new HybridAgentEngine({
      homePath: root,
      kernelServerScript: "",
      sandboxBackend: "local",
      model: { provider: "mock" },
    } as never);

    const report = await engine.execute({ tenantId: "wiring", goal: "Do a small thing" });

    // The learn hook ran: an experience exists for this tenant, with the
    // task's own goal and an honest outcome bucket.
    const experiences = await engine.experienceCompiler.getExperiences("wiring");
    expect(experiences.length).toBe(1);
    expect(experiences[0]!.taskDescription).toBe("Do a small thing");
    expect(["success", "failure", "partial"]).toContain(experiences[0]!.outcome);
    // The lesson is the report's summary — the compiler stores what the run
    // actually said, not a rewrite of it.
    expect(experiences[0]!.lesson).toBe(report.summary);
  }, 60_000);
});
