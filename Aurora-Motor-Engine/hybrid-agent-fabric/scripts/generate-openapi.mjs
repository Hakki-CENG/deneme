#!/usr/bin/env node
/**
 * Generate docs/openapi.yaml from the routes the control API actually registers.
 *
 * Why this exists: the hand-written spec described 7 paths while `main.ts` plus
 * `routes/*.ts` register 844. An integrator reading the spec saw under 1% of the
 * surface, and nothing failed when the two drifted apart.
 *
 * Design notes:
 *  - No YAML dependency. The seven curated paths carry hand-written schemas and
 *    descriptions, so their raw text is preserved byte-for-byte and the generated
 *    stubs are appended after them. Only top-level `paths:` keys are parsed, with
 *    a regex anchored on two-space indentation.
 *  - Extraction is static (`app.<method>("<path>"`). The control API registers no
 *    routes through the object form `app.route({...})`; `--check` re-counts the
 *    registrations and fails if that ever stops being true.
 *  - Generated operations deliberately carry no request/response schema. Inventing
 *    one would be a worse lie than omitting it, so each stub is marked
 *    `x-schema-status: unspecified` and points at its source file.
 *
 * Usage:
 *   node scripts/generate-openapi.mjs            # write docs/openapi.yaml
 *   node scripts/generate-openapi.mjs --check     # exit 1 if the file is stale
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = join(ROOT, "docs", "openapi.yaml");
// main.ts plus EVERY module under routes/. The list used to be hardcoded,
// and extracting a route group into a new file silently dropped its paths
// from the spec (862 -> 854) while --check stayed green: the check compares
// against a fresh generation over the same stale source list. Discovering
// the directory removes that drift class; sorting keeps the output stable.
const SOURCES = [
  "apps/control-api/src/main.ts",
  ...readdirSync(join(ROOT, "apps/control-api/src/routes"))
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => `apps/control-api/src/routes/${file}`),
];

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "all"];
const REGISTRATION = new RegExp(`\\bapp\\.(${HTTP_METHODS.join("|")})\\(\\s*(["'\`])([^"'\`]+)\\2`, "g");
// Guards the static-extraction assumption: a route registered through the object
// form would be invisible to REGISTRATION, so the count would silently understate.
const OBJECT_FORM = /\bapp\.route\(\s*\{/g;

const check = process.argv.includes("--check");

/** Fastify `/v1/sessions/:sessionId/chat` -> OpenAPI `/v1/sessions/{sessionId}/chat`. */
function toOpenApiPath(fastifyPath) {
  return fastifyPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function pathParams(openApiPath) {
  return [...openApiPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function tagFor(openApiPath) {
  const segments = openApiPath.split("/").filter(Boolean);
  // Skip the leading version segment so `/v1/sleep-cycle/...` tags as sleep-cycle.
  const meaningful = segments.find((segment) => !/^v\d+$/.test(segment));
  return meaningful ? meaningful.replace(/[{}]/g, "") : "root";
}

function operationId(method, openApiPath, seen) {
  const base =
    method +
    openApiPath
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]/g, ""))
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join("");
  const id = base || method;
  if (!seen.has(id)) {
    seen.add(id);
    return id;
  }
  let suffix = 2;
  while (seen.has(`${id}${suffix}`)) suffix += 1;
  seen.add(`${id}${suffix}`);
  return `${id}${suffix}`;
}

// ── Extract every registration ────────────────────────────────────────────────
const operations = new Map(); // openApiPath -> Map<method, sourceFile>
let registrations = 0;
let objectFormRegistrations = 0;

for (const source of SOURCES) {
  const text = readFileSync(join(ROOT, source), "utf8");
  objectFormRegistrations += (text.match(OBJECT_FORM) ?? []).length;
  for (const match of text.matchAll(REGISTRATION)) {
    const method = match[1];
    const openApiPath = toOpenApiPath(match[3]);
    registrations += 1;
    if (!operations.has(openApiPath)) operations.set(openApiPath, new Map());
    operations.get(openApiPath).set(method, relative(ROOT, join(ROOT, source)));
  }
}

if (objectFormRegistrations > 0) {
  console.error(
    `generate-openapi: ${objectFormRegistrations} route(s) use the object form app.route({...}), ` +
      `which this extractor does not read. Extend REGISTRATION before regenerating.`,
  );
  process.exit(1);
}

// ── Split the existing spec so curated content survives verbatim ──────────────
const existing = readFileSync(SPEC_PATH, "utf8");
const lines = existing.split("\n");
const pathsStart = lines.findIndex((line) => line === "paths:");
const componentsStart = lines.findIndex((line) => line === "components:");
if (pathsStart < 0 || componentsStart < 0 || componentsStart < pathsStart) {
  console.error("generate-openapi: docs/openapi.yaml must contain top-level `paths:` and `components:` keys.");
  process.exit(1);
}

const header = lines.slice(0, pathsStart + 1);
const rawCuratedBlock = lines.slice(pathsStart + 1, componentsStart);
const componentsBlock = lines.slice(componentsStart);

// The generated section lives inside the same `paths:` block, so a second run
// would otherwise read its own previous output back as "curated" and stack
// another copy of the banner on top. Everything from the sentinel down is
// discarded and rebuilt.
const GENERATED_BEGIN = "  # ── BEGIN GENERATED (npm run docs:openapi) ──";
const GENERATED_END = "  # ── END GENERATED ──";
const sentinel = rawCuratedBlock.indexOf(GENERATED_BEGIN);
const curatedBlock = sentinel >= 0 ? rawCuratedBlock.slice(0, sentinel) : rawCuratedBlock;
// Drop trailing blank lines so the rebuilt output has stable spacing.
while (curatedBlock.length > 0 && curatedBlock[curatedBlock.length - 1].trim() === "") curatedBlock.pop();

const PATH_KEY = /^ {2}\/\S*:$/;
const curatedPaths = new Set(
  curatedBlock.filter((line) => PATH_KEY.test(line)).map((line) => line.trim().replace(/:$/, "")),
);

// ── Emit ──────────────────────────────────────────────────────────────────────
const seenOperationIds = new Set();
// Reserve ids used by the curated paths so a generated stub cannot collide.
for (const line of curatedBlock) {
  const match = /^ {6}operationId:\s*(\S+)/.exec(line);
  if (match) seenOperationIds.add(match[1]);
}

const generatedPaths = [...operations.keys()].filter((path) => !curatedPaths.has(path)).sort();
const output = [...header, ...curatedBlock];

if (generatedPaths.length > 0) {
  output.push(GENERATED_BEGIN);
  output.push("  # AUTO-GENERATED — do not edit by hand.");
  output.push("  # Produced by `npm run docs:openapi` from the routes the control API");
  output.push("  # actually registers. Each operation below is a real, reachable route,");
  output.push("  # but its request/response schema is NOT specified: the handlers validate");
  output.push("  # with inline zod schemas that this generator does not evaluate.");
  output.push("  # `x-schema-status: unspecified` means \"unknown\", not \"empty\".");
}

for (const openApiPath of generatedPaths) {
  output.push(`  ${openApiPath}:`);
  const byMethod = operations.get(openApiPath);
  const params = pathParams(openApiPath);
  for (const method of HTTP_METHODS) {
    if (!byMethod.has(method)) continue;
    const source = byMethod.get(method);
    output.push(`    ${method}:`);
    output.push(`      tags: [${tagFor(openApiPath)}]`);
    output.push(`      operationId: ${operationId(method, openApiPath, seenOperationIds)}`);
    output.push(`      x-source: ${source}`);
    output.push(`      x-schema-status: unspecified`);
    if (params.length > 0) {
      output.push(`      parameters:`);
      for (const name of params) {
        output.push(`        - name: ${name}`);
        output.push(`          in: path`);
        output.push(`          required: true`);
        output.push(`          schema:`);
        output.push(`            type: string`);
      }
    }
    output.push(`      responses:`);
    output.push(`        '200':`);
    output.push(`          description: Successful response`);
  }
}

if (generatedPaths.length > 0) output.push(GENERATED_END);
output.push(...componentsBlock);

const rendered = `${output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;

const totalOperations = [...operations.values()].reduce((sum, byMethod) => sum + byMethod.size, 0);

if (check) {
  if (rendered !== existing) {
    console.error(
      `docs/openapi.yaml is stale.\n` +
        `  route registrations in source : ${registrations}\n` +
        `  curated paths (hand-written)  : ${curatedPaths.size}\n` +
        `  generated paths required      : ${generatedPaths.length}\n` +
        `Run \`npm run docs:openapi\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(
    `docs/openapi.yaml is current: ${registrations} registrations, ` +
      `${curatedPaths.size} curated + ${generatedPaths.length} generated paths.`,
  );
  process.exit(0);
}

writeFileSync(SPEC_PATH, rendered);
console.log(
  `Wrote docs/openapi.yaml\n` +
    `  registrations found in source : ${registrations}\n` +
    `  curated paths preserved       : ${curatedPaths.size}\n` +
    `  generated paths added         : ${generatedPaths.length}\n` +
    `  total operations              : ${totalOperations}`,
);
