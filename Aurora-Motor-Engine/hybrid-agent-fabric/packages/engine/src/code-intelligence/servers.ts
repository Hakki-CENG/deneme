import { constants as fsConstants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

/** Same dependency-noise exclusions as `filesystem.glob`/`filesystem.grep`. */
export const CODE_INTELLIGENCE_SKIP_DIRECTORIES = new Set([
  ".git", "node_modules", ".venv", "dist", "build", "target", ".next", "__pycache__",
  "coverage", ".turbo", ".cache", ".idea", ".vscode",
]);

export const MAX_LANGUAGE_WALK_FILES = 2000;
export const MAX_LANGUAGE_WALK_DEPTH = 20;

export interface LanguageProfile {
  languageId: string;
  label: string;
  extensions: string[];
  markers: string[];
  /** Optional LSP server id; commands without a server fall back to toolchain diagnostics. */
  serverId?: string;
  serverBinaries: string[];
  serverArgs: string[];
  serverInitOptions?: Record<string, unknown>;
}

export const LANGUAGE_PROFILES: LanguageProfile[] = [
  {
    languageId: "typescript",
    label: "TypeScript/JavaScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    markers: ["tsconfig.json", "package.json"],
    serverId: "typescript-language-server",
    serverBinaries: ["typescript-language-server"],
    serverArgs: ["--stdio"],
    serverInitOptions: { hostInfo: "aurora" },
  },
  {
    languageId: "python",
    label: "Python",
    extensions: [".py", ".pyi"],
    markers: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "pyrightconfig.json"],
    serverId: "pyright",
    serverBinaries: ["pyright-langserver", "pyright"],
    serverArgs: ["--stdio"],
    serverInitOptions: {},
  },
  {
    languageId: "go",
    label: "Go",
    extensions: [".go"],
    markers: ["go.mod"],
    serverId: "gopls",
    serverBinaries: ["gopls"],
    serverArgs: ["serve"],
    serverInitOptions: {},
  },
  {
    languageId: "rust",
    label: "Rust",
    extensions: [".rs"],
    markers: ["Cargo.toml"],
    serverId: "rust-analyzer",
    serverBinaries: ["rust-analyzer"],
    serverArgs: [],
    serverInitOptions: {},
  },
];

export function profileFor(filePath: string): LanguageProfile | undefined {
  const lower = filePath.toLowerCase();
  return LANGUAGE_PROFILES.find((profile) => profile.extensions.some((extension) => lower.endsWith(extension)));
}

export interface LanguageDetection {
  workspacePath: string;
  primaryLanguageId: string | null;
  markers: string[];
  languages: Array<LanguageProfile & { files: number }>;
}

export interface WalkedFile {
  path: string;
  size: number;
}

/** Bounded, dependency-noise-excluding workspace file walk. */
export async function walkWorkspaceFiles(
  workspacePath: string,
  options: { maxFiles?: number; maxDepth?: number } = {},
): Promise<WalkedFile[]> {
  const maxFiles = options.maxFiles ?? MAX_LANGUAGE_WALK_FILES;
  const maxDepth = options.maxDepth ?? MAX_LANGUAGE_WALK_DEPTH;
  const results: WalkedFile[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || results.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (CODE_INTELLIGENCE_SKIP_DIRECTORIES.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        await visit(full, depth + 1);
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => undefined);
        if (!info) continue;
        results.push({ path: full, size: info.size });
      }
    }
  };
  await visit(workspacePath, 0);
  return results;
}

/**
 * Detect which languages a workspace speaks and which LSP servers / toolchains
 * could back them. Marker files decide the primary language; extension counts
 * are the weighted vote when no marker exists (a lone `.py` file still counts).
 */
export async function detectLanguages(workspacePath: string): Promise<LanguageDetection> {
  const markers: string[] = [];
  const byMarker = new Set<string>();
  const files = await walkWorkspaceFiles(workspacePath, { maxFiles: MAX_LANGUAGE_WALK_FILES });
  const countByExtension = new Map<string, number>();
  for (const file of files) {
    const lower = file.path.toLowerCase();
    for (const profile of LANGUAGE_PROFILES) {
      for (const extension of profile.extensions) {
        if (lower.endsWith(extension)) {
          countByExtension.set(extension, (countByExtension.get(extension) ?? 0) + 1);
        }
      }
    }
  }
  const languages: Array<LanguageProfile & { files: number }> = [];
  for (const profile of LANGUAGE_PROFILES) {
    const foundMarkers: string[] = [];
    for (const marker of profile.markers) {
      const exists = await stat(join(workspacePath, marker)).then(() => true).catch(() => false);
      if (exists) {
        foundMarkers.push(marker);
        if (!byMarker.has(marker)) {
          byMarker.add(marker);
          markers.push(marker);
        }
      }
    }
    const filesCount = profile.extensions.reduce((sum, extension) => sum + (countByExtension.get(extension) ?? 0), 0);
    if (foundMarkers.length > 0 || filesCount > 0) {
      languages.push({ ...profile, files: filesCount });
    }
  }
  const primary = languages.slice().sort((a, b) => b.files - a.files)[0]?.languageId ?? null;
  return { workspacePath, primaryLanguageId: primary, markers, languages };
}

/**
 * Find a server binary the same way a shell would: the workspace-local
 * `node_modules/.bin` first (a project may pin its own language server), then
 * every directory on PATH. Returns the absolute path, or undefined.
 */
export async function findExecutable(candidates: string[], workspacePath: string): Promise<string | undefined> {
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const dirs = [join(workspacePath, "node_modules", ".bin"), ...pathDirs];
  for (const candidate of candidates) {
    for (const dir of dirs) {
      const full = join(dir, candidate);
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        await access(full, fsConstants.X_OK);
        return full;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined;
}

export async function findOnPath(name: string): Promise<string | undefined> {
  return await findExecutable([name], process.cwd());
}
