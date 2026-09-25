import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { ENGINE_NAME, ENGINE_VERSION, getVersionInfo } from "../src/version.js";

const PKG_PATH = resolve(process.cwd(), "package.json");
const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8")) as { name: string; version: string };
const DIST_VERSION_JS = resolve(process.cwd(), "dist/version.js");

describe("engine version source of truth", () => {
  it("reads the engine's own package.json instead of a hardcoded string", () => {
    expect(ENGINE_NAME).toBe("@haf/engine");
    expect(ENGINE_VERSION).toBe(pkg.version);
    // A fallback that fires would report 0.0.0-unknown; a reintroduced hardcoded
    // literal would drift from package.json the moment the version is bumped.
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reports the same version from getVersionInfo", () => {
    const info = getVersionInfo();
    expect(info.name).toBe("@haf/engine");
    expect(info.version).toBe(pkg.version);
    expect(info.node).toBe(process.version);
  });

  // The regression this pins: the module used to resolve
  // `resolve(__dirname, "../../package.json")`. From BOTH src/ (tsx) and dist/
  // (compiled) that lands on packages/package.json, which does not exist, so the
  // first branch always threw and the code silently fell through to
  // `process.cwd()/package.json`. Inside the repo that accidentally returned the
  // root workspace version; from any other cwd it returned nothing at all and
  // /health reported a stale hardcoded literal.
  //
  // So the assertion has to run from a cwd outside the repository — an in-process
  // check cannot see this bug, because vitest already chdirs the worker here.
  it.skipIf(!existsSync(DIST_VERSION_JS))(
    "resolves the version from the module location, not from process.cwd()",
    () => {
      const elsewhere = mkdtempSync(join(tmpdir(), "haf-version-probe-"));
      // A package.json in the probe directory that must NOT be picked up. If the
      // module ever resolves by cwd again, this is the value it would report.
      writeFileSync(
        join(elsewhere, "package.json"),
        JSON.stringify({ name: "decoy-not-the-engine", version: "9.9.9-decoy" }),
      );
      const probe = join(elsewhere, "probe.mjs");
      writeFileSync(
        probe,
        [
          `import { ENGINE_NAME, ENGINE_VERSION } from ${JSON.stringify(pathToFileURL(DIST_VERSION_JS).href)};`,
          `process.stdout.write(JSON.stringify({ ENGINE_NAME, ENGINE_VERSION }));`,
        ].join("\n"),
      );

      const raw = execFileSync(process.execPath, [probe], {
        cwd: elsewhere,
        encoding: "utf8",
        timeout: 30_000,
      });

      expect(JSON.parse(raw)).toEqual({ ENGINE_NAME: "@haf/engine", ENGINE_VERSION: pkg.version });
    },
  );
});
