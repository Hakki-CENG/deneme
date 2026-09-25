import { z } from "zod";
import type { CodeIntelligenceService } from "../code-intelligence/service.js";
import { defineCapability } from "./schema.js";

const severity = z.enum(["error", "warning", "info", "hint"]);
const position = z.object({ line: z.number().int().min(1).max(10_000_000), column: z.number().int().min(1).max(10_000_000) });

/**
 * Code intelligence as governed capabilities.
 *
 * `code.diagnostics.run` is the heavy one: it may spawn a language server or
 * run a compiler through the sandbox, so it carries the same `process` risk
 * class as `process.exec`. Everything else reads the workspace - symptoms of
 * what the code says, not effects on it - and is `workspace_read`.
 */
export function codeIntelligenceCapabilities(code: CodeIntelligenceService) {
  return [
    defineCapability(
      {
        id: "code.catalog",
        version: "1.0.0",
        description: "Languages detected in the workspace, available LSP servers and diagnostics toolchains, with the reasons when one is missing.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => await code.catalog(context.workspacePath),
    ),
    defineCapability(
      {
        id: "code.diagnostics.run",
        version: "1.0.0",
        description: "Run diagnostics over the workspace with the language server when one is installed, or the project toolchain through the sandbox. Stores bounded, durable evidence.",
        risk: "process",
        sideEffect: true,
        source: "core",
      },
      z.object({
        files: z.array(z.string().min(1).max(500)).max(60).optional(),
        severities: z.array(severity).min(1).max(4).optional(),
        forceToolchain: z.boolean().optional(),
      }),
      async (input, context) => await code.runDiagnostics({
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        ...(input.files ? { files: input.files } : {}),
        ...(input.severities ? { severities: input.severities } : {}),
        ...(input.forceToolchain ? { forceToolchain: true } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    ),
    defineCapability(
      {
        id: "code.diagnostics.evidence",
        version: "1.0.0",
        description: "The latest diagnostic run for this session, whether it is still fresh (content digests unchanged), and recent history.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({ limit: z.number().int().min(1).max(50).optional() }),
      async (input, context) => ({
        latest: await code.latest(context.tenantId, context.sessionId),
        history: await code.list({
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      }),
    ),
    defineCapability(
      {
        id: "code.symbols",
        version: "1.0.0",
        description: "Workspace symbols (or one file's symbols): functions, classes, interfaces, types and constants with locations. Uses the language server when available, otherwise a bounded structural scanner.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      z.object({ path: z.string().min(1).max(500).optional() }),
      async (input, context) => await code.symbols({
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        ...(input.path ? { path: input.path } : {}),
      }),
    ),
    defineCapability(
      {
        id: "code.definition",
        version: "1.0.0",
        description: "Where the identifier at a position is defined. Uses the language server when available; otherwise resolves against the structural symbol index.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      position.extend({ path: z.string().min(1).max(500) }),
      async (input, context) => await code.definition({
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        path: input.path,
        line: input.line,
        column: input.column,
      }),
    ),
    defineCapability(
      {
        id: "code.references",
        version: "1.0.0",
        description: "Where the identifier at a position is used across the workspace. Uses the language server when available; otherwise exact token search.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      position.extend({ path: z.string().min(1).max(500), includeDeclaration: z.boolean().optional() }),
      async (input, context) => await code.references({
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        path: input.path,
        line: input.line,
        column: input.column,
        ...(input.includeDeclaration === undefined ? {} : { includeDeclaration: input.includeDeclaration }),
      }),
    ),
    defineCapability(
      {
        id: "code.dependencies",
        version: "1.0.0",
        description: "Workspace import graph: file-to-file edges for relative imports and the external package specifiers each file depends on. Bounded, and honest when it hits the bound.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      z.object({}),
      async (_input, context) => await code.dependencies(context.workspacePath),
      { idempotency: "inherent" },
    ),
    defineCapability(
      {
        id: "code.patch.generate",
        version: "1.0.0",
        description: "Generate a unified diff between a file's current and intended content, in exactly the format filesystem.patch applies.",
        risk: "pure",
        sideEffect: false,
        source: "core",
      },
      z.object({
        edits: z.array(z.object({
          path: z.string().min(1).max(500),
          before: z.string().max(2_000_000),
          after: z.string().max(2_000_000),
        })).min(1).max(50),
      }),
      async ({ edits }) => {
        const diff = code.generatePatch(edits);
        return { diff, files: edits.length };
      },
      { idempotency: "inherent" },
    ),
    defineCapability(
      {
        id: "code.refactor.verify",
        version: "1.0.0",
        description: "Verify a refactor against a recorded diagnostics baseline: new errors regress, resolved errors improve, no change is clean.",
        risk: "workspace_read",
        sideEffect: false,
        source: "core",
      },
      z.object({ baselineRunId: z.string().min(1).max(200) }),
      async ({ baselineRunId }, context) => await code.refactorVerify({
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        baselineRunId,
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    ),
  ];
}
