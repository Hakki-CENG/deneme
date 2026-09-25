/**
 * Every registered error code must actually be produced somewhere.
 *
 * This exists because of a bug that lived undetected: `SESSION_NOT_FOUND`
 * (HAF-3001, 404) was in the registry, a test asserted it was in the registry,
 * and no code path ever returned it -- a missing session answered 500. The test
 * suite was green the whole time because it checked that the constant existed,
 * not that the behaviour happened.
 *
 * An audit found 24 of 47 registered codes in that state. Two were wired up; the
 * rest are listed below with the reason each is still dormant. The list is a
 * ratchet, not a pardon: a newly registered code that nothing produces fails this
 * test, and an entry here that starts being produced also fails it, so the list
 * can only shrink.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ErrorCodes } from "../src/middleware/error-handler.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, "..");
const HANDLER = join(PACKAGE, "src/middleware/error-handler.ts");

/**
 * Registered codes nothing produces yet, and why.
 *
 * Each one is a real gap, not an acceptable state: the API documents a response
 * it never sends. They are listed rather than deleted because the conditions are
 * expected to exist and wiring them needs work in the layer that detects them.
 */
/**
 * Registered codes nothing produces yet.
 *
 * Empty. Every entry that used to be here has been either wired to the
 * condition that should return it or removed from the registry:
 *
 * - `AURORA_THOUGHT_ERROR` — no HTTP surface calls thought processing, so
 *   nothing could ever return it. Removed rather than kept as a documented
 *   response the API cannot send.
 * - `RESOURCE_QUOTA_EXCEEDED` — no resource quota is enforced anywhere in the
 *   engine, so there is no condition to return it from. Removed for the same
 *   reason. Adding quota enforcement is real work; registering a code is not.
 *
 * A new entry here is a debt being taken on, not a state being described.
 */
const DORMANT: Record<string, string> = {};

function collectSources(directory: string): Array<{ path: string; text: string }> {
  const found: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectSources(full));
    } else if (entry.endsWith(".ts")) {
      found.push({ path: full, text: readFileSync(full, "utf-8") });
    }
  }
  return found;
}

function registeredCodes(): string[] {
  const source = readFileSync(HANDLER, "utf-8");
  const start = source.indexOf("export const ErrorCodes");
  const end = source.indexOf("} as const;", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  return [...block.matchAll(/^\s{2}([A-Z_0-9]+):\s*\{/gm)].map((match) => match[1]!);
}

/**
 * Where a code is produced: anywhere except its own definition inside the
 * registry block. Usage inside the handler counts -- that is where the
 * translations live.
 */
function producingText(): string {
  const source = readFileSync(HANDLER, "utf-8");
  const start = source.indexOf("export const ErrorCodes");
  const end = source.indexOf("} as const;", start) + "} as const;".length;
  const outsideRegistry = source.slice(0, start) + source.slice(end);

  // This file is excluded: it names every dormant code in the DORMANT map, so
  // scanning it would report all of them as produced and the ratchet would never
  // fire. Self-referential audits pass for the wrong reason.
  const self = fileURLToPath(import.meta.url);
  const others = [...collectSources(join(PACKAGE, "src")), ...collectSources(join(PACKAGE, "test"))]
    .filter((file) => file.path !== HANDLER && file.path !== self)
    .map((file) => file.text)
    .join("\n");

  return `${outsideRegistry}\n${others}`;
}

describe("the error code registry", () => {
  const codes = registeredCodes();
  const corpus = producingText();
  const dormant = codes.filter((name) => !corpus.includes(name));

  it("registers the codes this file knows about", () => {
    // Guards the audit itself: if the parser silently matched nothing, every
    // other assertion here would pass vacuously.
    expect(codes.length).toBeGreaterThanOrEqual(40);
    expect(codes).toContain("SESSION_NOT_FOUND");
  });

  it("has no dormant code that is not accounted for", () => {
    const unexplained = dormant.filter((name) => !(name in DORMANT));
    expect(
      unexplained,
      "These registered codes are never produced. Either wire the condition that " +
        "should return them, or add them to DORMANT with the reason they are dormant.",
    ).toEqual([]);
  });

  it("has no accounted-for code that has since been wired up", () => {
    const stale = Object.keys(DORMANT).filter((name) => !dormant.includes(name));
    expect(
      stale,
      "These codes are produced now, so remove them from DORMANT -- the list is " +
        "meant to shrink as the debt is paid down.",
    ).toEqual([]);
  });

  it("accounts for every code exactly one way", () => {
    // A code is either produced or dormant; the two sets must partition the
    // registry, and DORMANT must not name something that is not registered.
    const unknown = Object.keys(DORMANT).filter((name) => !codes.includes(name));
    expect(unknown).toEqual([]);
    expect(dormant.length + (codes.length - dormant.length)).toBe(codes.length);
  });

  it("exposes every registered code on ErrorCodes with a status", () => {
    for (const name of codes) {
      const entry = (ErrorCodes as Record<string, { code: string; status: number }>)[name];
      expect(entry, `${name} is registered in the block but missing from ErrorCodes`).toBeDefined();
      expect(entry.code).toMatch(/^HAF-\d{4}$/);
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
    }
  });

  it("does not reuse a code string for two conditions", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [name, entry] of Object.entries(ErrorCodes)) {
      const previous = seen.get(entry.code);
      if (previous) duplicates.push(`${entry.code}: ${previous} and ${name}`);
      else seen.set(entry.code, name);
    }
    // Two conditions sharing one code cannot be told apart by a client.
    expect(duplicates).toEqual([]);
  });

  it("keeps the dormant list a minority of the registry", () => {
    // A tripwire on the direction of travel: if more than half the registry is
    // documentation for responses that never happen, the registry is fiction.
    expect(dormant.length).toBeLessThan(codes.length / 2);
    expect(relative(PACKAGE, HANDLER)).toBe("src/middleware/error-handler.ts");
  });
});
