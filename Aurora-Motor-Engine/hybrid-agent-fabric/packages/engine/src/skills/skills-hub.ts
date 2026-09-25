import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { x as extractTar } from "tar";
import { assertSafeUrl } from "../capabilities/web.js";
import type { SkillManifest, SkillRegistry } from "./skill-registry.js";
import { atomicWrite } from "../util/atomic-file.js";

export interface SkillHubSource {
  id: string;
  indexUrl: string;
  trust: "trusted" | "community";
  enabled: boolean;
  addedAt: string;
  lastRefreshAt?: string;
  lastErrorClass?: string;
}

export interface SkillHubEntry {
  sourceId: string;
  name: string;
  version: string;
  description: string;
  bundleUrl: string;
  sha256: string;
  tags: string[];
  trust: SkillHubSource["trust"];
  /** Optional supply-chain metadata: an Ed25519 signature over the artefact digest, and its publisher. */
  signature?: string;
  publisherId?: string;
}

interface HubState {
  sources: SkillHubSource[];
  entries: SkillHubEntry[];
}

async function boundedDownload(url: URL, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: "manual", headers: { "user-agent": "HybridAgentFabric-SkillsHub/0.6" } });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Skill Hub redirect omitted Location.");
    return await boundedDownload(await assertSafeUrl(new URL(location, url).toString()), maxBytes);
  }
  if (!response.ok) throw new Error(`Skill Hub HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("Skill Hub download exceeds the byte limit.");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Skill Hub download exceeded the byte limit while streaming.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export class SkillsHub {
  private state: HubState = { sources: [], entries: [] };
  private loaded = false;

  constructor(
    private readonly rootPath: string,
    private readonly registry: SkillRegistry,
    /** Optional supply-chain gate. Absent means the previous behaviour: digest checking only. */
    private readonly trustGate?: {
      assertInstallable(input: { tenantId: string; kind: "skill"; artifactId: string; version: string; sha256: string; signature?: string; publisherId?: string }): Promise<unknown>;
    },
  ) {}

  private get statePath(): string { return join(this.rootPath, "skills", ".hub", "state.json"); }
  private get auditPath(): string { return join(this.rootPath, "skills", ".hub", "audit.jsonl"); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as HubState;
      this.state = {
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await atomicWrite(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private async audit(action: string, detail: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.auditPath), { recursive: true });
    await appendFile(this.auditPath, `${JSON.stringify({ timestamp: new Date().toISOString(), action, ...detail })}\n`, { mode: 0o600 });
  }

  async addSource(input: { id: string; indexUrl: string; trust?: SkillHubSource["trust"] }): Promise<SkillHubSource> {
    await this.load();
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(input.id)) throw new Error("Skill Hub source id is invalid.");
    await assertSafeUrl(input.indexUrl);
    if (this.state.sources.some((source) => source.id === input.id)) throw new Error(`Skill Hub source ${input.id} already exists.`);
    const source: SkillHubSource = {
      id: input.id,
      indexUrl: input.indexUrl,
      trust: input.trust ?? "community",
      enabled: true,
      addedAt: new Date().toISOString(),
    };
    this.state.sources.push(source);
    await this.save();
    await this.audit("source.add", { sourceId: source.id, trust: source.trust, indexUrl: source.indexUrl });
    return structuredClone(source);
  }

  async listSources(): Promise<SkillHubSource[]> {
    await this.load();
    return this.state.sources.map((source) => structuredClone(source));
  }

  async refresh(sourceId?: string): Promise<{ refreshed: string[]; failed: string[] }> {
    await this.load();
    const sources = this.state.sources.filter((source) => source.enabled && (!sourceId || source.id === sourceId));
    const refreshed: string[] = [], failed: string[] = [];
    for (const source of sources) {
      try {
        const url = await assertSafeUrl(source.indexUrl);
        const bytes = await boundedDownload(url, 2 * 1024 * 1024);
        const index = JSON.parse(bytes.toString("utf8")) as { version?: unknown; skills?: unknown };
        if (index.version !== 1 || !Array.isArray(index.skills)) throw new Error("Skill Hub index schema is invalid.");
        const entries: SkillHubEntry[] = [];
        for (const raw of index.skills as any[]) {
          if (!raw || typeof raw !== "object") throw new Error("Skill Hub index entry is invalid.");
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.name) || typeof raw.version !== "string" || typeof raw.description !== "string") {
            throw new Error("Skill Hub entry identity is invalid.");
          }
          if (!/^[a-f0-9]{64}$/i.test(raw.sha256) || typeof raw.bundleUrl !== "string") throw new Error("Skill Hub entry hash/URL is invalid.");
          await assertSafeUrl(raw.bundleUrl);
          entries.push({
            sourceId: source.id,
            name: raw.name,
            version: raw.version,
            description: raw.description,
            bundleUrl: raw.bundleUrl,
            sha256: raw.sha256.toLowerCase(),
            tags: Array.isArray(raw.tags) ? raw.tags.filter((tag: unknown): tag is string => typeof tag === "string").slice(0, 50) : [],
            trust: source.trust,
          });
        }
        this.state.entries = [...this.state.entries.filter((entry) => entry.sourceId !== source.id), ...entries];
        source.lastRefreshAt = new Date().toISOString();
        delete source.lastErrorClass;
        refreshed.push(source.id);
        await this.audit("source.refresh", { sourceId: source.id, entries: entries.length });
      } catch (error) {
        source.lastErrorClass = error instanceof Error ? error.name : "unknown";
        failed.push(source.id);
        await this.audit("source.refresh_failed", { sourceId: source.id, errorClass: source.lastErrorClass });
      }
    }
    await this.save();
    return { refreshed, failed };
  }

  async search(query: string, options: { sourceId?: string; limit?: number } = {}): Promise<SkillHubEntry[]> {
    await this.load();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.state.entries
      .filter((entry) => !options.sourceId || entry.sourceId === options.sourceId)
      .map((entry) => ({ entry, score: terms.reduce((score, term) => score + (`${entry.name} ${entry.description} ${entry.tags.join(" ")}`.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(({ score }) => !terms.length || score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, options.limit ?? 50)
      .map(({ entry }) => structuredClone(entry));
  }

  async install(input: { sourceId: string; name: string; version?: string; tenantId?: string }): Promise<SkillManifest> {
    await this.load();
    const candidates = this.state.entries.filter((entry) => entry.sourceId === input.sourceId && entry.name === input.name && (!input.version || entry.version === input.version));
    const entry = candidates.sort((a, b) => b.version.localeCompare(a.version))[0];
    if (!entry) throw new Error("Skill Hub entry not found.");
    // Supply-chain trust is evaluated before a single byte is fetched: a refused artefact should not
    // even be downloaded, let alone extracted.
    if (this.trustGate) {
      await this.trustGate.assertInstallable({
        tenantId: input.tenantId ?? "local",
        kind: "skill",
        artifactId: `${entry.sourceId}:${entry.name}`,
        version: entry.version,
        sha256: entry.sha256,
        ...(entry.signature ? { signature: entry.signature } : {}),
        ...(entry.publisherId ? { publisherId: entry.publisherId } : {}),
      });
    }
    const downloadUrl = await assertSafeUrl(entry.bundleUrl);
    const bytes = await boundedDownload(downloadUrl, 10 * 1024 * 1024);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== entry.sha256) {
      await this.audit("bundle.hash_mismatch", { sourceId: entry.sourceId, name: entry.name, expected: entry.sha256, actual: hash });
      throw new Error("Skill bundle SHA-256 mismatch.");
    }

    const operationId = randomUUID();
    const operationRoot = join(this.rootPath, "skills", ".hub", "downloads", operationId);
    const archivePath = join(operationRoot, "bundle.tar.gz");
    const extractRoot = join(operationRoot, "extract");
    await mkdir(extractRoot, { recursive: true });
    await writeFile(archivePath, bytes, { mode: 0o600 });
    let entries = 0, totalBytes = 0;
    let archiveViolation: string | undefined;
    try {
      await extractTar({
        file: archivePath,
        cwd: extractRoot,
        strict: true,
        preservePaths: false,
        filter: (path, tarEntry) => {
          entries++;
          totalBytes += Number(tarEntry.size ?? 0);
          const normalized = path.replaceAll("\\", "/");
          if (entries > 1000 || totalBytes > 50 * 1024 * 1024) archiveViolation = "Skill archive exceeds extraction limits.";
          else if (isAbsolute(normalized) || normalized.split("/").includes("..")) archiveViolation = "Skill archive contains path traversal.";
          else if (["SymbolicLink", "Link"].includes(String((tarEntry as { type?: unknown }).type))) archiveViolation = "Skill archive contains links.";
          return !archiveViolation;
        },
      });
      if (archiveViolation) throw new Error(archiveViolation);
      const roots = await this.findSkillRoots(extractRoot);
      if (roots.length !== 1) throw new Error(`Skill archive must contain exactly one SKILL.md root; found ${roots.length}.`);
      const manifest = await this.registry.importBundleDirectory({
        sourceDirectory: roots[0]!,
        name: entry.name,
        version: entry.version,
        description: entry.description,
        source: `hub:${entry.sourceId}:${entry.bundleUrl}`,
        createdBy: "user",
      });
      await this.audit("bundle.quarantined", {
        sourceId: entry.sourceId, name: entry.name, version: entry.version,
        hash, trust: entry.trust, verdict: manifest.status,
      });
      return manifest;
    } finally {
      await rm(operationRoot, { recursive: true, force: true });
    }
  }

  private async findSkillRoots(root: string): Promise<string[]> {
    const output: string[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isSymbolicLink()) throw new Error("Extracted skill contains a symlink.");
        if (item.isFile() && item.name === "SKILL.md") output.push(directory);
        else if (item.isDirectory()) await walk(path, depth + 1);
      }
    };
    await walk(root, 0);
    return [...new Set(output)];
  }
}
