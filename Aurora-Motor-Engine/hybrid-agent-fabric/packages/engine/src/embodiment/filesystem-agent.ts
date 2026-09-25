/**
 * File System Agent
 * Provides Aurora with file system capabilities.
 * Read, write, search, and manage files in the workspace.
 */

import { readFile, writeFile, readdir, stat, mkdir, unlink, rename, copyFile, lstat } from "node:fs/promises";
import { resolve, join, relative, dirname, basename, extname, isAbsolute } from "node:path";
import { glob } from "glob";

export interface FileSystemAgentConfig {
  /** Allowed paths (relative to workspace root) */
  allowedPaths: string[];
  /** Blocked paths (never access) */
  blockedPaths: string[];
  /** Maximum file size for read (bytes) */
  maxReadSize: number;
  /** Maximum file size for write (bytes) */
  maxWriteSize: number;
  /** Enable search capabilities */
  enableSearch: boolean;
  /** Maximum search results */
  maxSearchResults: number;
  /** Enable symlink following (default: false for security) */
  followSymlinks: boolean;
}

const DEFAULT_CONFIG: FileSystemAgentConfig = {
  allowedPaths: ["*"],
  blockedPaths: ["node_modules", ".git", ".env", "*.key", "*.pem"],
  maxReadSize: 10 * 1024 * 1024, // 10MB
  maxWriteSize: 5 * 1024 * 1024, // 5MB
  enableSearch: true,
  maxSearchResults: 100,
  followSymlinks: false,
};

export interface FileInfo {
  path: string;
  name: string;
  extension: string;
  size: number;
  isDirectory: boolean;
  modified: string;
  created: string;
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  match: string;
  context: string;
}

export class FileSystemAgent {
  private config: FileSystemAgentConfig;
  private workspaceRoot: string;

  constructor(workspaceRoot: string, config: Partial<FileSystemAgentConfig> = {}) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a path is allowed.
   * Security checks:
   *   1. Reject null bytes (null byte injection)
   *   2. Reject absolute paths (must be relative to workspace)
   *   3. Reject UNC paths (Windows network paths)
   *   4. Reject device paths (CON, NUL, etc.)
   *   5. Resolve and verify confinement (must stay within workspace)
   *   6. Check blocked patterns
   *   7. Check allowed patterns
   */
  private isPathAllowed(path: string): boolean {
    // 1. Null byte injection
    if (path.includes("\0")) return false;

    // 2. Absolute paths must be rejected — only relative paths allowed
    if (isAbsolute(path)) return false;

    // 3. UNC paths (Windows: \\server\share)
    if (path.startsWith("\\\\")) return false;

    // 4. Device paths (Windows: CON, NUL, COM1, etc.)
    const deviceName = basename(path).split(".")[0]!.toUpperCase();
    if (["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5",
         "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4",
         "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].includes(deviceName)) return false;

    // 5. Resolve and verify confinement
    const resolved = resolve(this.workspaceRoot, path);
    const relPath = relative(this.workspaceRoot, resolved);

    // Must not escape workspace (../.. attacks)
    if (relPath.startsWith("..") || relPath === "..") return false;

    // Normalize path separators for cross-platform matching
    const normalizedRel = relPath.replace(/\\/g, "/");

    // 6. Check blocked paths
    for (const blocked of this.config.blockedPaths) {
      const normalizedBlocked = blocked.replace(/\\/g, "/");
      // Exact match
      if (normalizedRel === normalizedBlocked) return false;
      // Prefix match (directory)
      if (normalizedRel.startsWith(normalizedBlocked + "/")) return false;
      // Glob pattern match
      try {
        const pattern = normalizedBlocked.replace(/\*/g, ".*").replace(/\?/g, ".");
        if (new RegExp(`^${pattern}$`).test(normalizedRel)) return false;
        if (new RegExp(`^${pattern}/`).test(normalizedRel)) return false;
      } catch {
        // Invalid regex pattern — skip
      }
    }

    // 7. Check allowed paths
    if (this.config.allowedPaths.includes("*")) return true;
    return this.config.allowedPaths.some((allowed) => {
      const normalizedAllowed = allowed.replace(/\\/g, "/");
      if (normalizedRel === normalizedAllowed) return true;
      if (normalizedRel.startsWith(normalizedAllowed + "/")) return true;
      try {
        const pattern = normalizedAllowed.replace(/\*/g, ".*").replace(/\?/g, ".");
        return new RegExp(`^${pattern}$`).test(normalizedRel);
      } catch {
        return false;
      }
    });
  }

  /**
   * Resolve a path with symlink safety check.
   * If followSymlinks is false, rejects symlinks that point outside workspace.
   */
  private async resolveSafePath(path: string): Promise<string> {
    const resolved = resolve(this.workspaceRoot, path);

    if (!this.config.followSymlinks) {
      try {
        const linkStat = await lstat(resolved);
        if (linkStat.isSymbolicLink()) {
          // Read the symlink target
          const { readlink } = await import("node:fs/promises");
          const target = await readlink(resolved);
          const resolvedTarget = resolve(dirname(resolved), target);
          const relTarget = relative(this.workspaceRoot, resolvedTarget);
          if (relTarget.startsWith("..")) {
            throw new Error(`Symlink escape detected: ${path} → ${target}`);
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("Symlink escape")) throw err;
        // File doesn't exist yet — ok for write operations
      }
    }

    return resolved;
  }

  /**
   * Read a file
   */
  async readFile(path: string): Promise<{ content: string; info: FileInfo }> {
    if (!this.isPathAllowed(path)) {
      throw new Error(`Access denied: ${path}`);
    }

    const fullPath = await this.resolveSafePath(path);
    const fileStat = await stat(fullPath);

    if (fileStat.size > this.config.maxReadSize) {
      throw new Error(`File too large: ${fileStat.size} bytes (max: ${this.config.maxReadSize})`);
    }

    const content = await readFile(fullPath, "utf-8");
    return {
      content,
      info: this.createFileInfo(fullPath, fileStat),
    };
  }

  /**
   * Write a file
   */
  async writeFile(path: string, content: string): Promise<FileInfo> {
    if (!this.isPathAllowed(path)) {
      throw new Error(`Access denied: ${path}`);
    }

    if (content.length > this.config.maxWriteSize) {
      throw new Error(`Content too large: ${content.length} bytes (max: ${this.config.maxWriteSize})`);
    }

    const fullPath = await this.resolveSafePath(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");

    const fileStat = await stat(fullPath);
    return this.createFileInfo(fullPath, fileStat);
  }

  /**
   * List directory contents
   */
  async listDirectory(path: string = "."): Promise<FileInfo[]> {
    if (!this.isPathAllowed(path)) {
      throw new Error(`Access denied: ${path}`);
    }

    const fullPath = await this.resolveSafePath(path);
    const entries = await readdir(fullPath, { withFileTypes: true });

    const results: FileInfo[] = [];
    for (const entry of entries) {
      const entryPath = join(fullPath, entry.name);
      try {
        const fileStat = await stat(entryPath);
        results.push(this.createFileInfo(entryPath, fileStat));
      } catch {
        // Skip inaccessible entries
      }
    }

    return results;
  }

  /**
   * Create a directory
   */
  async createDirectory(path: string): Promise<void> {
    if (!this.isPathAllowed(path)) {
      throw new Error(`Access denied: ${path}`);
    }

    const fullPath = await this.resolveSafePath(path);
    await mkdir(fullPath, { recursive: true });
  }

  /**
   * Delete a file
   */
  async deleteFile(path: string): Promise<void> {
    if (!this.isPathAllowed(path)) {
      throw new Error(`Access denied: ${path}`);
    }

    const fullPath = await this.resolveSafePath(path);
    await unlink(fullPath);
  }

  /**
   * Rename/move a file
   */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    if (!this.isPathAllowed(oldPath) || !this.isPathAllowed(newPath)) {
      throw new Error(`Access denied`);
    }

    const fullOldPath = await this.resolveSafePath(oldPath);
    const fullNewPath = await this.resolveSafePath(newPath);
    await mkdir(dirname(fullNewPath), { recursive: true });
    await rename(fullOldPath, fullNewPath);
  }

  /**
   * Copy a file
   */
  async copyFile(source: string, destination: string): Promise<void> {
    if (!this.isPathAllowed(source) || !this.isPathAllowed(destination)) {
      throw new Error(`Access denied`);
    }

    const fullSource = await this.resolveSafePath(source);
    const fullDestination = await this.resolveSafePath(destination);
    await mkdir(dirname(fullDestination), { recursive: true });
    await copyFile(fullSource, fullDestination);
  }

  /**
   * Search for files by pattern
   */
  async findFiles(pattern: string): Promise<FileInfo[]> {
    if (!this.config.enableSearch) {
      throw new Error("Search is disabled");
    }

    const files = await glob(pattern, {
      cwd: this.workspaceRoot,
      ignore: this.config.blockedPaths,
      nodir: false,
    });

    const results: FileInfo[] = [];
    for (const file of files.slice(0, this.config.maxSearchResults)) {
      try {
        const fullPath = resolve(this.workspaceRoot, file);
        const fileStat = await stat(fullPath);
        results.push(this.createFileInfo(fullPath, fileStat));
      } catch {
        // Skip inaccessible files
      }
    }

    return results;
  }

  /**
   * Search for text content in files
   */
  async searchContent(query: string, path: string = ".", filePattern: string = "*"): Promise<SearchResult[]> {
    if (!this.config.enableSearch) {
      throw new Error("Search is disabled");
    }

    if (!this.isPathAllowed(path)) {
      throw new Error(`Access denied: ${path}`);
    }

    const results: SearchResult[] = [];
    const files = await this.findFiles(join(path, filePattern));

    for (const file of files) {
      if (file.isDirectory) continue;
      if (file.size > this.config.maxReadSize) continue;

      try {
        const content = await readFile(resolve(this.workspaceRoot, file.path), "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const columnIndex = line.toLowerCase().indexOf(query.toLowerCase());
          if (columnIndex !== -1) {
            results.push({
              path: file.path,
              line: i + 1,
              column: columnIndex + 1,
              match: line.trim(),
              context: lines.slice(Math.max(0, i - 1), i + 2).join("\n"),
            });

            if (results.length >= this.config.maxSearchResults) {
              return results;
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return results;
  }

  /**
   * Get file info
   */
  async getFileInfo(path: string): Promise<FileInfo> {
    if (!this.isPathAllowed(path)) {
      throw new Error(`Access denied: ${path}`);
    }

    const fullPath = await this.resolveSafePath(path);
    const fileStat = await stat(fullPath);
    return this.createFileInfo(fullPath, fileStat);
  }

  /**
   * Create FileInfo from path and stat
   */
  private createFileInfo(fullPath: string, fileStat: any): FileInfo {
    return {
      path: relative(this.workspaceRoot, fullPath),
      name: basename(fullPath),
      extension: extname(fullPath),
      size: fileStat.size,
      isDirectory: fileStat.isDirectory(),
      modified: new Date(fileStat.mtime).toISOString(),
      created: new Date(fileStat.birthtime).toISOString(),
    };
  }

  /**
   * Get agent statistics
   */
  stats(): {
    workspaceRoot: string;
    config: FileSystemAgentConfig;
  } {
    return {
      workspaceRoot: this.workspaceRoot,
      config: this.config,
    };
  }
}
