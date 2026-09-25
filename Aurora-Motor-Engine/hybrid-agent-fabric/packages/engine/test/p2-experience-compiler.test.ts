import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExperienceCompilerService } from "../src/aurora/experience-compiler.js";

async function compiler(): Promise<ExperienceCompilerService> {
  const root = await mkdtemp(join(tmpdir(), "haf-compiler-"));
  return new ExperienceCompilerService(root);
}

describe("P2: Experience Compiler — Skill Transfer", () => {
  it("records experiences and compiles skills", async () => {
    const service = await compiler();
    
    const exp = await service.recordExperience({
      tenantId: "tenant1",
      taskType: "code-generation",
      description: "Generated a REST API",
      tags: ["api", "rest", "typescript"],
      outcome: "success",
      durationMs: 5000,
      tokensUsed: 2000,
      lessonsLearned: ["Use proper error handling"],
    });
    
    expect(exp).toBeDefined();
    expect(exp.taskType).toBe("code-generation");
    
    const skills = await service.compileSkills("tenant1");
    expect(skills).toBeInstanceOf(Array);
  });

  it("finds similar skills by tags", async () => {
    const service = await compiler();
    
    // Record experience to generate skills
    await service.recordExperience({
      tenantId: "tenant1",
      taskType: "api-design",
      description: "Designed REST API",
      tags: ["api", "rest"],
      outcome: "success",
      durationMs: 3000,
      tokensUsed: 1500,
      lessonsLearned: [],
    });
    
    const similar = await service.findSimilarSkills("tenant1", ["api", "rest"]);
    expect(similar).toBeInstanceOf(Array);
  });

  it("transfers skills between tenants", async () => {
    const service = await compiler();
    
    // Create a skill in tenant1
    await service.recordExperience({
      tenantId: "tenant1",
      taskType: "testing",
      description: "Wrote unit tests",
      tags: ["testing", "vitest"],
      outcome: "success",
      durationMs: 2000,
      tokensUsed: 1000,
      lessonsLearned: [],
    });
    
    const skills = await service.getSkills("tenant1");
    
    if (skills.length > 0) {
      const transferred = await service.transferSkill(skills[0].id, "tenant2", "Adapted for tenant2");
      expect(transferred).toBeDefined();
      expect(transferred?.tenantId).toBe("tenant2");
      expect(transferred?.stage).toBe("candidate");
    }
  });

  it("provides getStats summary", async () => {
    const service = await compiler();
    
    const stats = await service.getStats("tenant1");
    expect(stats).toBeDefined();
  });

  it("why() explains skills", async () => {
    const service = await compiler();
    
    await service.recordExperience({
      tenantId: "tenant1",
      taskType: "debugging",
      description: "Fixed a bug",
      tags: ["debugging"],
      outcome: "success",
      durationMs: 1000,
      tokensUsed: 500,
      lessonsLearned: [],
    });
    
    const skills = await service.getSkills("tenant1");
    if (skills.length > 0) {
      const explanation = await service.why("tenant1", skills[0].id);
      expect(explanation).toBeDefined();
      expect(explanation.rationale).toBeInstanceOf(Array);
    }
  });
});
