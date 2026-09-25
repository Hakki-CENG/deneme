#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepareRelease, verifyRelease } from "./release.js";

/**
 * This tool's own version, read from the workspace package.json.
 *
 * The help text and the signed provenance/SBOM used to hardcode "1.38.0", so
 * every attestation the tool produced identified itself as 27 releases old no
 * matter which version was actually running. `../package.json` resolves to the
 * app root from both `src/` and `dist/`, so one path works for both.
 */
const RELEASE_TOOL_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version ?? "0.0.0-unknown";

const [command = "help", ...args] = process.argv.slice(2);
if (command === "prepare") {
  const parsed = parseArgs(args);
  const rootPath = resolve(parsed.values.root ?? process.cwd());
  const outputPath = resolve(parsed.values.output ?? resolve(rootPath, "release-metadata"));
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH === undefined ? undefined : number(process.env.SOURCE_DATE_EPOCH, "SOURCE_DATE_EPOCH");
  const result = await prepareRelease({
    rootPath,
    outputPath,
    artifacts: parsed.artifacts,
    ...(sourceDateEpoch !== undefined ? { sourceDateEpoch } : {}),
    ...(parsed.values.builder ? { builderId: parsed.values.builder } : {}),
    ...(process.env.HAF_RELEASE_SIGNING_KEY ? { signingPrivateKeyPem: process.env.HAF_RELEASE_SIGNING_KEY } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (command === "verify") {
  const parsed = parseArgs(args);
  const outputPath = resolve(parsed.values.output ?? resolve(process.cwd(), "release-metadata"));
  process.stdout.write(`${JSON.stringify(await verifyRelease(outputPath))}\n`);
} else if (["help", "--help", "-h"].includes(command)) {
  process.stdout.write(
    `Hybrid Agent Fabric release tool ${RELEASE_TOOL_VERSION}\n\n` +
    "  haf-release prepare [--root PATH] [--output PATH] [--artifact PATH ...] [--builder ID]\n" +
    "  haf-release verify [--output PATH]\n\n" +
    "Optional signing reads Ed25519 PEM only from HAF_RELEASE_SIGNING_KEY.\n" +
    "Reproducible timestamps use SOURCE_DATE_EPOCH. Keys are never accepted as CLI arguments.\n",
  );
} else throw new Error(`Unknown release command: ${command}`);

function parseArgs(args: string[]): { values: Record<string, string>; artifacts: string[] } {
  const values: Record<string, string> = {}, artifacts: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--root", "--output", "--artifact", "--builder"].includes(key ?? "")) throw new Error(`Unknown release option: ${key}`);
    const value = args[++index];
    if (!value || value.startsWith("--") || value.length > 4096) throw new Error(`${key} requires a bounded value.`);
    if (key === "--artifact") artifacts.push(value);
    else values[key!.slice(2)] = value;
  }
  if (artifacts.length > 100) throw new Error("A release is limited to 100 artifacts.");
  return { values, artifacts };
}
function number(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}
