/**
 * Version Source of Truth
 * Always reads from package.json — never hardcode version strings.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

interface PackageJson {
  name?: string;
  version?: string;
}

/**
 * The engine's own package.json, found by walking up from this module.
 *
 * Walking up (rather than hardcoding `../package.json`) is what makes this work
 * in every layout this file is ever loaded from:
 *   - `src/version.ts` under tsx        → packages/engine/src
 *   - `dist/version.js` after tsc       → packages/engine/dist
 * Both are one level below the package root, but a bundler or a nested outDir
 * would break a fixed relative hop, so the walk stops on the first
 * package.json that actually names this package.
 */
function findOwnPackageJson(): PackageJson | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as PackageJson;
        if (parsed.name === "@haf/engine" && typeof parsed.version === "string") return parsed;
      } catch {
        // Unreadable or malformed package.json is not fatal; keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const own = findOwnPackageJson();

/** Engine version — single source of truth from packages/engine/package.json */
export const ENGINE_VERSION: string = own?.version ?? "0.0.0-unknown";

/** Engine name */
export const ENGINE_NAME: string = own?.name ?? "@haf/engine";

/** Health/status response shape */
export function getVersionInfo() {
  return {
    name: ENGINE_NAME,
    version: ENGINE_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    uptime: Math.floor(process.uptime()),
  };
}
