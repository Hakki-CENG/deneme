import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { SandboxFactory } from "../sandbox/sandbox.js";

/**
 * P1.39 environment mapper: what is actually installed and available where
 * the agent is about to work.
 *
 * Every fact reported here is measured, not assumed: interpreter versions
 * come from running `<tool> --version` in the session's own sandbox, device
 * state from `df`/`nproc`/`free`, project structure from a bounded walk of
 * the workspace. A fact that cannot be measured is reported as unavailable —
 * never filled in with a guess.
 *
 * Network reachability is deliberately NOT probed: an outbound check from
 * here would be both slow and a side channel. The report says so instead.
 */
export class EnvironmentProbe {
  private cache?: { at: number; report: EnvironmentReport };

  constructor(
    private readonly factory: SandboxFactory,
    private readonly ttlMs = 60_000,
  ) {}

  async probe(workspacePath: string, options?: { refresh?: boolean }): Promise<EnvironmentReport> {
    if (!options?.refresh && this.cache && Date.now() - this.cache.at < this.ttlMs) {
      return structuredClone(this.cache.report);
    }
    const [interpreters, device, projectStructure] = await Promise.all([
      this.probeInterpreters(workspacePath),
      this.probeDevice(workspacePath),
      this.probeProject(workspacePath),
    ]);
    const report: EnvironmentReport = {
      interpreters,
      device,
      projectStructure,
      network: {
        probed: false,
        reason: "Outbound network reachability is not measured by the probe; it would be a slow side channel. Test connectivity with the capability that needs it.",
      },
      generatedAt: new Date().toISOString(),
    };
    this.cache = { at: Date.now(), report };
    return structuredClone(report);
  }

  private async run(workspacePath: string, command: string): Promise<string | undefined> {
    const sandbox = await this.factory(workspacePath);
    try {
      const result = await sandbox.exec({ command, timeoutMs: 15_000, maxOutputChars: 4_000 });
      if (result.exitCode !== 0) return undefined;
      const output = result.stdout.trim();
      return output.length ? output.slice(0, 400) : undefined;
    } catch {
      return undefined;
    } finally {
      await sandbox.destroy();
    }
  }

  private async probeInterpreters(workspacePath: string): Promise<EnvironmentInterpreter[]> {
    const tools = [
      { id: "node", command: "node --version" },
      { id: "npm", command: "npm --version" },
      { id: "python3", command: "python3 --version" },
      { id: "pip3", command: "pip3 --version" },
      { id: "git", command: "git --version" },
      { id: "make", command: "make --version" },
      { id: "tsc", command: "tsc --version" },
    ];
    const results = await Promise.all(tools.map(async (tool) => {
      const version = await this.run(workspacePath, tool.command);
      return { id: tool.id, ...(version ? { version } : {}), available: version !== undefined } satisfies EnvironmentInterpreter;
    }));
    return results;
  }

  private async probeDevice(workspacePath: string): Promise<EnvironmentDevice> {
    const [disk, cpus, memory] = await Promise.all([
      this.run(workspacePath, `df -k "${workspacePath.replace(/"/g, "")}" | tail -1`),
      this.run(workspacePath, "nproc"),
      this.run(workspacePath, "free -m | sed -n '2p'"),
    ]);
    const diskFreeBytes = disk ? Number(disk.split(/\s+/)[3] ?? "") * 1024 : undefined;
    const cpuCount = cpus ? Number(cpus.trim()) : undefined;
    const memoryTotalMb = memory ? Number(memory.split(/\s+/)[1] ?? "") : undefined;
    return {
      ...(Number.isFinite(diskFreeBytes) ? { diskFreeBytes: diskFreeBytes! } : {}),
      ...(Number.isFinite(cpuCount) ? { cpuCount: cpuCount! } : {}),
      ...(Number.isFinite(memoryTotalMb) ? { memoryTotalMb: memoryTotalMb! } : {}),
      measured: Number.isFinite(diskFreeBytes) || Number.isFinite(cpuCount) || Number.isFinite(memoryTotalMb),
    };
  }

  private async probeProject(workspacePath: string): Promise<EnvironmentProject> {
    const MAX_FILES = 5_000;
    const SKIP = new Set([".git", "node_modules", ".venv", "dist", "build", "target", "__pycache__", "coverage"]);
    const languages = new Map<string, number>();
    const topDirectories: string[] = [];
    let fileCount = 0;
    let capped = false;
    const walk = async (directory: string, depth: number): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (fileCount >= MAX_FILES) {
          capped = true;
          return;
        }
        if (SKIP.has(entry.name)) continue;
        if (depth === 0 && entry.isDirectory()) topDirectories.push(entry.name);
        const full = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile()) {
          fileCount += 1;
          const extension = entry.name.includes(".") ? entry.name.split(".").pop()!.toLowerCase() : "";
          if (["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "rb", "md", "json"].includes(extension)) {
            languages.set(extension, (languages.get(extension) ?? 0) + 1);
          }
        }
      }
    };
    await walk(workspacePath, 0);
    return {
      topDirectories: topDirectories.slice(0, 50),
      fileCount,
      capped,
      languages: Object.fromEntries([...languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
    };
  }
}

export interface EnvironmentInterpreter {
  id: string;
  version?: string;
  available: boolean;
}

export interface EnvironmentDevice {
  diskFreeBytes?: number;
  cpuCount?: number;
  memoryTotalMb?: number;
  measured: boolean;
}

export interface EnvironmentProject {
  topDirectories: string[];
  fileCount: number;
  capped: boolean;
  languages: Record<string, number>;
}

export interface EnvironmentReport {
  interpreters: EnvironmentInterpreter[];
  device: EnvironmentDevice;
  projectStructure: EnvironmentProject;
  network: { probed: boolean; reason: string };
  generatedAt: string;
}
