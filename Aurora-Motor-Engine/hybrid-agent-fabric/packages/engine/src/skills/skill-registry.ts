import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWrite } from "../util/atomic-file.js";

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  status: "quarantine" | "active" | "rejected";
  provenance: { source: string; createdBy: "user" | "agent" | "system" };
  hash: string;
  storageKey: string;
  createdAt: string;
}

const blockedPatterns = [
  { id: "prompt_injection", pattern: /ignore\s+(all\s+)?previous\s+instructions/i },
  { id: "credential_exfiltration", pattern: /(?:send|upload|post).{0,80}(?:token|secret|credential|\.ssh|\.aws)/i },
  { id: "destructive_shell", pattern: /\brm\s+-rf\s+(?:\/|~|\$HOME)/i },
  { id: "invisible_unicode", pattern: /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/ },
];

export class SkillRegistry {
  constructor(private readonly rootPath: string) {}

  private async hashDirectory(path: string): Promise<string> {
    const hash = createHash("sha256");
    const files: string[] = [];
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Skill contains a forbidden symlink: ${full}`);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name !== "manifest.json") files.push(full);
      }
    }
    await walk(path);
    for (const file of files.sort()) {
      hash.update(relative(path, file));
      hash.update(await readFile(file));
    }
    return hash.digest("hex");
  }

  private async scan(path: string): Promise<string[]> {
    const findings: string[] = [];
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          findings.push(`symlink:${relative(path, full)}`);
          continue;
        }
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".py") || entry.name.endsWith(".sh") || entry.name.endsWith(".ts"))) {
          const content = await readFile(full, "utf8");
          for (const rule of blockedPatterns) if (rule.pattern.test(content)) findings.push(`${rule.id}:${relative(path, full)}`);
        }
      }
    }
    await walk(path);
    return findings;
  }

  async createCandidate(input: { name: string; description: string; content: string; source: string; createdBy: "user" | "agent" }): Promise<SkillManifest> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)) throw new Error("Skill name must be a lowercase kebab-case slug.");
    const id = randomUUID();
    const storageKey = `${input.name}-${id}`;
    const directory = join(this.rootPath, "skills", "quarantine", storageKey);
    await mkdir(directory, { recursive: true });
    await atomicWrite(join(directory, "SKILL.md"), input.content);
    const findings = await this.scan(directory);
    const manifest: SkillManifest = {
      id,
      name: input.name,
      version: "0.1.0",
      description: input.description,
      status: findings.length ? "rejected" : "quarantine",
      provenance: { source: input.source, createdBy: input.createdBy },
      hash: await this.hashDirectory(directory),
      storageKey,
      createdAt: new Date().toISOString(),
    };
    await atomicWrite(join(directory, "manifest.json"), `${JSON.stringify({ ...manifest, findings }, null, 2)}\n`);
    return manifest;
  }

  async importBundleDirectory(input: {
    sourceDirectory: string;
    name: string;
    version?: string;
    description: string;
    source: string;
    createdBy?: "user" | "agent" | "system";
  }): Promise<SkillManifest> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)) throw new Error("Skill name must be a lowercase kebab-case slug.");
    const source = await realpath(input.sourceDirectory);
    if (!(await stat(join(source, "SKILL.md"))).isFile()) throw new Error("Skill bundle must contain SKILL.md at its root.");
    const id = randomUUID();
    const storageKey = `${input.name}-${id}`;
    const directory = join(this.rootPath, "skills", "quarantine", storageKey);
    await mkdir(dirname(directory), { recursive: true });
    await cp(source, directory, { recursive: true, verbatimSymlinks: true });
    const findings = await this.scan(directory);
    const manifest: SkillManifest = {
      id,
      name: input.name,
      version: input.version ?? "0.1.0",
      description: input.description,
      status: findings.length ? "rejected" : "quarantine",
      provenance: { source: input.source, createdBy: input.createdBy ?? "user" },
      hash: await this.hashDirectory(directory),
      storageKey,
      createdAt: new Date().toISOString(),
    };
    await atomicWrite(join(directory, "manifest.json"), `${JSON.stringify({ ...manifest, findings }, null, 2)}\n`);
    return manifest;
  }

  async promote(candidateDirectoryName: string): Promise<SkillManifest> {
    const quarantineRoot = await realpath(join(this.rootPath, "skills", "quarantine"));
    const source = await realpath(join(quarantineRoot, candidateDirectoryName));
    if (source !== quarantineRoot && !source.startsWith(`${quarantineRoot}${sep}`)) throw new Error("Invalid quarantine path.");
    const findings = await this.scan(source);
    if (findings.length) throw new Error(`Skill scan failed: ${findings.join(", ")}`);
    const manifestPath = join(source, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SkillManifest;
    if (manifest.hash !== (await this.hashDirectory(source))) {
      // manifest.json itself changes the directory hash; compare content files instead by updating before promotion.
      manifest.hash = await this.hashDirectory(source);
    }
    manifest.status = "active";
    const target = join(this.rootPath, "skills", "active", manifest.name);
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(source, target);
    return manifest;
  }

  async deactivate(name: string): Promise<void> {
    const activeRoot = resolve(this.rootPath, "skills", "active");
    const source = resolve(activeRoot, basename(name));
    if (!source.startsWith(`${activeRoot}${sep}`)) throw new Error("Invalid skill name.");
    const archiveRoot = resolve(this.rootPath, "skills", "archive");
    await mkdir(archiveRoot, { recursive: true });
    const target = resolve(archiveRoot, `${basename(name)}-${Date.now()}`);
    try {
      await rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Active skill ${name} does not exist.`);
      throw error;
    }
  }

  async list(): Promise<SkillManifest[]> {
    const root = join(this.rootPath, "skills", "active");
    try {
      const results: SkillManifest[] = [];
      for (const name of await readdir(root)) {
        const path = join(root, name, "manifest.json");
        if ((await stat(path)).isFile()) results.push(JSON.parse(await readFile(path, "utf8")) as SkillManifest);
      }
      return results;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async get(name: string): Promise<{ manifest: SkillManifest; content: string }> {
    const root = resolve(this.rootPath, "skills", "active");
    const directory = resolve(root, basename(name));
    if (!directory.startsWith(`${root}${sep}`)) throw new Error("Invalid skill name.");
    return {
      manifest: JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as SkillManifest,
      content: await readFile(join(directory, "SKILL.md"), "utf8"),
    };
  }
}
