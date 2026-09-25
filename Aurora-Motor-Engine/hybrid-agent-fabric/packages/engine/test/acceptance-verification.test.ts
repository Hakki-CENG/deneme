/**
 * Real workspace + acceptance verification — the last open P0 item.
 *
 * Everything else in the P0 list was about deciding *what* happened. This is
 * about proving it on disk: the agent claims it wrote a file, and the loop only
 * reports `succeeded` if that file is really there with the right content.
 *
 * The two failure modes that matter are both about evidence, not correctness:
 *
 *   - a claim with no workspace to check must be `unverified`, never success;
 *   - a check that reads outside the workspace must fail, because a repository
 *     file the agent never touched is not proof of the agent's work.
 */

import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UnifiedExecutionLoop } from "../src/execution/unified-execution-loop.js";
import { acceptanceVerifier } from "../src/execution/verification-factory.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "haf-acceptance-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("acceptance is judged on the real workspace", () => {
  it("passes when the agent really wrote the file", async () => {
    const verifier = acceptanceVerifier("acceptance", workspace, [
      { file: "hello.txt", contains: ["hello world"] },
    ]);

    await writeFile(join(workspace, "hello.txt"), "hello world\n");

    const result = await verifier.run({} as never);
    expect(result.verdict).toBe("pass");
    expect(result.evidence).toContain("hello.txt");
  });

  it("fails when the file was never written", async () => {
    const verifier = acceptanceVerifier("acceptance", workspace, [{ file: "hello.txt" }]);

    const result = await verifier.run({} as never);
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toContain("not found");
  });

  it("fails when the content is wrong", async () => {
    await writeFile(join(workspace, "port.txt"), "3000");
    const verifier = acceptanceVerifier("acceptance", workspace, [
      { file: "port.txt", contains: ["8080"] },
    ]);

    const result = await verifier.run({} as never);
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toContain("missing");
  });

  it("checks nested files", async () => {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const port = 8080;");

    const verifier = acceptanceVerifier("acceptance", workspace, [
      { file: "src/index.ts", matches: /port\s*=\s*8080/ },
    ]);

    expect((await verifier.run({} as never)).verdict).toBe("pass");
  });
});

describe("absent evidence is never success", () => {
  it("returns uncertain when no workspace exists", async () => {
    const verifier = acceptanceVerifier("acceptance", undefined, [{ file: "hello.txt" }]);
    const result = await verifier.run({} as never);

    expect(result.verdict).toBe("uncertain");
    expect(result.verdict).not.toBe("pass");
    expect(result.confidence).toBe(0);
  });

  it("returns uncertain for an empty checklist", async () => {
    const verifier = acceptanceVerifier("acceptance", workspace, []);
    const result = await verifier.run({} as never);

    expect(result.verdict).toBe("uncertain");
    expect(result.evidence).toContain("proves nothing");
  });

  it("refuses to be satisfied by a file outside the workspace", async () => {
    // package.json exists up the tree, but the agent never touched it.
    const verifier = acceptanceVerifier("acceptance", workspace, [
      { file: "../../../package.json" },
    ]);

    const result = await verifier.run({} as never);
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toContain("outside the workspace");
  });
});

describe("the execution loop reports on disk evidence, not on the agent's word", () => {
  it("succeeds only when the workspace really changed", async () => {
    const runAgent = vi.fn(async () => {
      await writeFile(join(workspace, "report.md"), "# Findings\nAll three files scanned.\n");
      return { completed: true, summary: "Wrote report.md" };
    });

    const loop = new UnifiedExecutionLoop({
      runAgent,
      verifiersFor: async (context) => [
        acceptanceVerifier("acceptance", context.workspace, [
          { file: "report.md", contains: ["Findings"] },
        ]),
      ],
    });

    const report = await loop.run({ tenantId: "t", goal: "Write a report", workspace });

    expect(report.status).toBe("succeeded");
    expect(await readFile(join(workspace, "report.md"), "utf8")).toContain("Findings");
  });

  it("does not report success when the agent claims work it did not do", async () => {
    // The classic fabricated success: a confident summary, an untouched disk.
    const runAgent = vi.fn(async () => ({
      completed: true,
      summary: "I have written report.md with the full analysis.",
    }));

    const loop = new UnifiedExecutionLoop(
      {
        runAgent,
        verifiersFor: async (context) => [
          acceptanceVerifier("acceptance", context.workspace, [
            { file: "report.md", contains: ["Findings"] },
          ]),
        ],
      },
      { maxAttempts: 1 },
    );

    const report = await loop.run({ tenantId: "t", goal: "Write a report", workspace });

    expect(report.status).not.toBe("succeeded");
    expect(JSON.stringify(report)).toContain("not found");
  });

  it("reports unverified — not succeeded — when there is no workspace to check", async () => {
    const loop = new UnifiedExecutionLoop(
      {
        runAgent: async () => ({ completed: true, summary: "Done." }),
        verifiersFor: async (context) => [
          acceptanceVerifier("acceptance", context.workspace, [{ file: "report.md" }]),
        ],
      },
      { maxAttempts: 1 },
    );

    const report = await loop.run({ tenantId: "t", goal: "Write a report" });

    expect(report.status).toBe("unverified");
  });
});
