import { z } from "zod";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { defineCapability } from "./schema.js";

export function skillCapabilities(registry: SkillRegistry) {
  return [
    defineCapability(
      { id: "skills.list", version: "1.0.0", description: "List active skills.", risk: "pure", sideEffect: false, source: "core" },
      z.object({}),
      async () => ({ skills: await registry.list() }),
    ),
    defineCapability(
      { id: "skills.get", version: "1.0.0", description: "Load one active skill on demand.", risk: "workspace_read", sideEffect: false, source: "core" },
      z.object({ name: z.string().min(1) }),
      async ({ name }) => await registry.get(name),
    ),
    defineCapability(
      { id: "skills.propose", version: "1.0.0", description: "Create a quarantined skill candidate; never auto-promotes globally.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ name: z.string(), description: z.string().max(500), content: z.string().max(100_000) }),
      async ({ name, description, content }) =>
        await registry.createCandidate({ name, description, content, source: "agent-session", createdBy: "agent" }),
    ),
  ];
}
