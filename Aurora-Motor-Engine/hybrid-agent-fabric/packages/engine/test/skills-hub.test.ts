import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { c as createTar } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillRegistry } from "../src/skills/skill-registry.js";
import { SkillsHub } from "../src/skills/skills-hub.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function bundle(root: string, maliciousLink = false): Promise<Buffer> {
  const source = join(root, maliciousLink ? "bad-skill" : "good-skill");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "# Good Skill\n\nRun verified checks.");
  if (maliciousLink) await symlink("/etc/passwd", join(source, "escape"));
  const archive = join(root, maliciousLink ? "bad.tar.gz" : "good.tar.gz");
  await createTar({ gzip: true, cwd: root, file: archive }, [maliciousLink ? "bad-skill" : "good-skill"]);
  return await readFile(archive);
}

describe("Skills Hub quarantine pipeline", () => {
  it("refreshes a public catalog, verifies hash, extracts safely and requires explicit promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-hub-"));
    const archive = await bundle(root);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const index = { version: 1, skills: [{
      name: "good-skill", version: "1.2.3", description: "A verified workflow",
      bundleUrl: "https://93.184.216.34/good.tar.gz", sha256, tags: ["test"],
    }] };
    globalThis.fetch = vi.fn(async (url) => String(url).endsWith("index.json")
      ? new Response(JSON.stringify(index), { status: 200 })
      : new Response(archive, { status: 200 })) as typeof fetch;
    const registry = new SkillRegistry(root);
    const hub = new SkillsHub(root, registry);
    await hub.addSource({ id: "community", indexUrl: "https://93.184.216.34/index.json", trust: "community" });
    expect(await hub.refresh()).toEqual({ refreshed: ["community"], failed: [] });
    expect((await hub.search("verified"))[0]?.name).toBe("good-skill");
    const candidate = await hub.install({ sourceId: "community", name: "good-skill" });
    expect(candidate.status).toBe("quarantine");
    expect(await registry.list()).toHaveLength(0);
    await registry.promote(candidate.storageKey);
    expect((await registry.get("good-skill")).manifest.version).toBe("1.2.3");
  });

  it("rejects hash mismatch and archive links", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-hub-"));
    const archive = await bundle(root, true);
    let index: any = { version: 1, skills: [{
      name: "bad-skill", version: "1.0.0", description: "bad",
      bundleUrl: "https://93.184.216.34/bad.tar.gz", sha256: "0".repeat(64), tags: [],
    }] };
    globalThis.fetch = vi.fn(async (url) => String(url).endsWith("index.json")
      ? new Response(JSON.stringify(index), { status: 200 })
      : new Response(archive, { status: 200 })) as typeof fetch;
    const hub = new SkillsHub(root, new SkillRegistry(root));
    await hub.addSource({ id: "community", indexUrl: "https://93.184.216.34/index.json" });
    await hub.refresh();
    await expect(hub.install({ sourceId: "community", name: "bad-skill" })).rejects.toThrow("SHA-256 mismatch");

    index.skills[0].sha256 = createHash("sha256").update(archive).digest("hex");
    await hub.refresh();
    await expect(hub.install({ sourceId: "community", name: "bad-skill" })).rejects.toThrow("links");
  });
});
