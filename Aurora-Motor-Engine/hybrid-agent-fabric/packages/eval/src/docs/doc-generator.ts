/**
 * Documentation Generator
 * Automatically generates documentation for the eval system.
 * 
 * Features:
 *   - API documentation from TypeScript types
 *   - Usage examples generation
 *   - Configuration documentation
 *   - Report templates
 *   - README generation
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let SRC_DIR: string;
let DOCS_DIR: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  SRC_DIR = resolve(__dirname, "..");
  DOCS_DIR = resolve(__dirname, "../../../docs/eval");
} catch {
  SRC_DIR = resolve(process.cwd(), "packages/eval/src");
  DOCS_DIR = resolve(process.cwd(), "packages/eval/docs");
}

export interface DocSection {
  title: string;
  content: string;
  subsections: DocSection[];
}

export interface ModuleDoc {
  moduleName: string;
  description: string;
  exports: ExportDoc[];
  examples: string[];
  configuration: Record<string, unknown>;
}

export interface ExportDoc {
  name: string;
  type: "function" | "class" | "interface" | "type" | "const";
  description: string;
  parameters?: { name: string; type: string; description: string }[];
  returnType?: string;
  returnDescription?: string;
  examples: string[];
}

/**
 * Generate documentation for a module.
 */
export async function generateModuleDoc(modulePath: string): Promise<ModuleDoc> {
  const content = await readFile(modulePath, "utf-8");
  const moduleName = modulePath.split("/").pop()?.replace(".ts", "") ?? "unknown";

  // Extract exports (simplified - would use AST in production)
  const exports = extractExports(content);

  // Extract JSDoc comments
  const description = extractDescription(content);

  return {
    moduleName,
    description,
    exports,
    examples: generateExamples(exports),
    configuration: extractConfiguration(content),
  };
}

/**
 * Extract exports from TypeScript source.
 */
function extractExports(content: string): ExportDoc[] {
  const exports: ExportDoc[] = [];

  // Match export function
  const functionRegex = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*:\s*([^\n{]+)/g;
  let match;

  while ((match = functionRegex.exec(content)) !== null) {
    const name = match[1] ?? "";
    const params = match[2] ?? "";
    const returnType = match[3]?.trim() ?? "void";

    exports.push({
      name,
      type: "function",
      description: extractJSDoc(content, name),
      parameters: parseParameters(params),
      returnType,
      returnDescription: "",
      examples: [],
    });
  }

  // Match export interface
  const interfaceRegex = /export\s+interface\s+(\w+)/g;
  while ((match = interfaceRegex.exec(content)) !== null) {
    const name = match[1] ?? "";
    exports.push({
      name,
      type: "interface",
      description: extractJSDoc(content, name),
      examples: [],
    });
  }

  // Match export type
  const typeRegex = /export\s+type\s+(\w+)/g;
  while ((match = typeRegex.exec(content)) !== null) {
    const name = match[1] ?? "";
    exports.push({
      name,
      type: "type",
      description: extractJSDoc(content, name),
      examples: [],
    });
  }

  // Match export const
  const constRegex = /export\s+const\s+(\w+)/g;
  while ((match = constRegex.exec(content)) !== null) {
    const name = match[1] ?? "";
    exports.push({
      name,
      type: "const",
      description: extractJSDoc(content, name),
      examples: [],
    });
  }

  return exports;
}

/**
 * Extract JSDoc comment for a symbol.
 */
function extractJSDoc(content: string, symbolName: string): string {
  const regex = new RegExp(`\\/\\*\\*\\s*\\n([^*]|\\*[^\\/])*\\*\\/\\s*\\n\\s*(?:export\\s+)?(?:function|class|interface|type|const)\\s+${symbolName}`, "i");
  const match = content.match(regex);

  if (match && match[0]) {
    const docMatch = match[0].match(/\/\*\*\s*\n([\s\S]*?)\*\//);
    if (docMatch && docMatch[1]) {
      return docMatch[1]
        .split("\n")
        .map(line => line.replace(/^\s*\*\s?/, "").trim())
        .filter(line => !line.startsWith("@"))
        .join(" ")
        .trim();
    }
  }

  return "";
}

/**
 * Extract description from file header.
 */
function extractDescription(content: string): string {
  const match = content.match(/\/\*\*\s*\n([\s\S]*?)\*\//);
  if (match && match[1]) {
    return match[1]
      .split("\n")
      .map(line => line.replace(/^\s*\*\s?/, "").trim())
      .filter(line => !line.startsWith("@"))
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Parse function parameters.
 */
function parseParameters(params: string): { name: string; type: string; description: string }[] {
  if (!params.trim()) return [];

  return params.split(",").map(param => {
    const parts = param.trim().split(":");
    const name = parts[0]?.trim() ?? "";
    const type = parts[1]?.trim() ?? "unknown";
    return { name, type, description: "" };
  });
}

/**
 * Extract configuration from content.
 */
function extractConfiguration(content: string): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  // Find DEFAULT_* constants
  const defaultRegex = /export\s+const\s+(DEFAULT_\w+)\s*=\s*({[\s\S]*?});/g;
  let match;

  while ((match = defaultRegex.exec(content)) !== null) {
    const name = match[1] ?? "";
    config[name] = "See source code";
  }

  return config;
}

/**
 * Generate examples for exports.
 */
function generateExamples(exports: ExportDoc[]): string[] {
  const examples: string[] = [];

  for (const exp of exports) {
    if (exp.type === "function") {
      const params = exp.parameters?.map(p => p.name).join(", ") ?? "";
      examples.push(`import { ${exp.name} } from '@haf/eval';\nconst result = await ${exp.name}(${params});`);
    }
  }

  return examples;
}

/**
 * Generate README for the eval package.
 */
export async function generateReadme(): Promise<string> {
  const lines: string[] = [];

  lines.push("# @haf/eval");
  lines.push("");
  lines.push("Aurora Motor Engine evaluation framework with trajectory recording, difficulty scoring, and CI/CD integration.");
  lines.push("");

  // Features
  lines.push("## Features");
  lines.push("");
  lines.push("- **Engine Eval** — Run tasks against Aurora engine");
  lines.push("- **Trajectory Recording** — Record cognitive events during eval");
  lines.push("- **Difficulty Scoring** — Weight tasks by difficulty level");
  lines.push("- **Regression Detection** — Detect score regressions between runs");
  lines.push("- **Performance Benchmarking** — Track execution times and bottlenecks");
  lines.push("- **Cost Tracking** — Monitor token usage and costs");
  lines.push("- **Quality Gates** — CI/CD integration with pass/fail gates");
  lines.push("- **Continuous Monitoring** — Health checks and alerts");
  lines.push("- **Auto-Recovery** — Circuit breaker and retry logic");
  lines.push("- **A/B Testing** — Compare different configurations");
  lines.push("- **Experiment Tracking** — Centralized experiment history");
  lines.push("");

  // Installation
  lines.push("## Installation");
  lines.push("");
  lines.push("```bash");
  lines.push("npm install @haf/eval");
  lines.push("```");
  lines.push("");

  // Quick Start
  lines.push("## Quick Start");
  lines.push("");
  lines.push("```typescript");
  lines.push("import { runEngineEvalWithTrajectory } from '@haf/eval';");
  lines.push("");
  lines.push("// Run full eval with all features");
  lines.push("const result = await runEngineEvalWithTrajectory({");
  lines.push("  maxTasks: 75,");
  lines.push("  verbose: true,");
  lines.push("  generateReport: true,");
  lines.push("});");
  lines.push("");
  lines.push("console.log(`Score: ${(result.overallScore * 100).toFixed(1)}%`);");
  lines.push("```");
  lines.push("");

  // CLI Commands
  lines.push("## CLI Commands");
  lines.push("");
  lines.push("```bash");
  lines.push("# Full eval with trajectory recording");
  lines.push("npx tsx packages/eval/src/runner/engine-eval-trajectory.ts --max-tasks 75");
  lines.push("");
  lines.push("# Dashboard");
  lines.push("npx tsx packages/eval/src/dashboard/eval-dashboard.ts");
  lines.push("");
  lines.push("# Regression detection");
  lines.push("npx tsx packages/eval/src/monitoring/regression-detector.ts");
  lines.push("");
  lines.push("# Performance benchmark");
  lines.push("npx tsx packages/eval/src/benchmarking/performance-benchmark.ts");
  lines.push("");
  lines.push("# Cost tracking");
  lines.push("npx tsx packages/eval/src/cost/cost-tracker.ts --model gpt-4");
  lines.push("");
  lines.push("# Quality gates (CI/CD)");
  lines.push("npx tsx packages/eval/src/quality/quality-gates.ts");
  lines.push("");
  lines.push("# Continuous monitoring");
  lines.push("npx tsx packages/eval/src/monitoring/continuous-monitor.ts");
  lines.push("");
  lines.push("# Auto-recovery");
  lines.push("npx tsx packages/eval/src/recovery/auto-recovery.ts");
  lines.push("");
  lines.push("# A/B testing");
  lines.push("npx tsx packages/eval/src/testing/ab-testing.ts");
  lines.push("");
  lines.push("# Experiment tracking");
  lines.push("npx tsx packages/eval/src/tracking/experiment-tracker.ts");
  lines.push("```");
  lines.push("");

  // Architecture
  lines.push("## Architecture");
  lines.push("");
  lines.push("```");
  lines.push("┌─────────────────────────────────────────────────────────┐");
  lines.push("│                    ENGINE EVAL                           │");
  lines.push("│         75 tasks × 11 categories × 5 difficulty        │");
  lines.push("└──────────────────┬──────────────────────────────────────┘");
  lines.push("                   │");
  lines.push("                   ▼");
  lines.push("┌─────────────────────────────────────────────────────────┐");
  lines.push("│         TRAJECTORY RECORDING                            │");
  lines.push("│         EventBus → TrajectoryBridge → TrajectoryStore   │");
  lines.push("└──────────────────┬──────────────────────────────────────┘");
  lines.push("                   │");
  lines.push("                   ▼");
  lines.push("┌─────────────────────────────────────────────────────────┐");
  lines.push("│         ANALYSIS & SCORING                              │");
  lines.push("│         Difficulty → Regression → Benchmark → Cost      │");
  lines.push("└──────────────────┬──────────────────────────────────────┘");
  lines.push("                   │");
  lines.push("                   ▼");
  lines.push("┌─────────────────────────────────────────────────────────┐");
  lines.push("│         QUALITY & RECOVERY                              │");
  lines.push("│         Quality Gates → Auto-Recovery → Monitoring      │");
  lines.push("└──────────────────┬──────────────────────────────────────┘");
  lines.push("                   │");
  lines.push("                   ▼");
  lines.push("┌─────────────────────────────────────────────────────────┐");
  lines.push("│         TESTING & TRACKING                              │");
  lines.push("│         A/B Testing → Experiment Tracking → Reports     │");
  lines.push("└─────────────────────────────────────────────────────────┘");
  lines.push("```");
  lines.push("");

  // Reports
  lines.push("## Generated Reports");
  lines.push("");
  lines.push("| Report | Description |");
  lines.push("|--------|-------------|");
  lines.push("| self-improvement-report.md | Category scores, service health |");
  lines.push("| difficulty-analysis.md | Difficulty-based analysis |");
  lines.push("| regression-report.md | Regression detection |");
  lines.push("| benchmark-report.md | Performance benchmarking |");
  lines.push("| cost-report.md | Cost tracking |");
  lines.push("| quality-gate-report.md | CI/CD quality gates |");
  lines.push("| monitor-report.md | Continuous monitoring |");
  lines.push("| recovery-report.md | Auto-recovery |");
  lines.push("| dashboard.md | Progress tracking |");
  lines.push("| experiment-tracker-report.md | Experiment tracking |");
  lines.push("");

  // Configuration
  lines.push("## Configuration");
  lines.push("");
  lines.push("```typescript");
  lines.push("// Quality Gates configuration");
  lines.push("const gates = {");
  lines.push("  minScore: 0.95,           // 95% minimum score");
  lines.push("  maxRegressions: 0,        // No regressions allowed");
  lines.push("  maxBudgetUsd: 50,         // $50 max budget");
  lines.push("  maxAvgDurationMs: 100,    // 100ms max avg duration");
  lines.push("  minThroughput: 10,        // 10 tasks/sec minimum");
  lines.push("  categoryGates: {");
  lines.push("    security: { minScore: 1.0 },  // Security must be 100%");
  lines.push("  },");
  lines.push("};");
  lines.push("```");
  lines.push("");

  // License
  lines.push("## License");
  lines.push("");
  lines.push("MIT");
  lines.push("");

  return lines.join("\n");
}

/**
 * Run documentation generation.
 */
export async function runDocGeneration(): Promise<void> {
  console.log("📚 Generating documentation...");

  await mkdir(DOCS_DIR, { recursive: true });

  // Generate README
  const readme = await generateReadme();
  const readmePath = join(DOCS_DIR, "README.md");
  await writeFile(readmePath, readme);
  console.log(`📄 README saved to: ${readmePath}`);

  // Generate module docs
  const modules = [
    "runner/engine-eval-trajectory.ts",
    "dashboard/eval-dashboard.ts",
    "scoring/difficulty-scorer.ts",
    "monitoring/regression-detector.ts",
    "benchmarking/performance-benchmark.ts",
    "cost/cost-tracker.ts",
    "quality/quality-gates.ts",
    "monitoring/continuous-monitor.ts",
    "recovery/auto-recovery.ts",
    "testing/ab-testing.ts",
    "tracking/experiment-tracker.ts",
  ];

  for (const module of modules) {
    try {
      const modulePath = join(SRC_DIR, module);
      const doc = await generateModuleDoc(modulePath);
      const docPath = join(DOCS_DIR, `${doc.moduleName}.md`);

      const lines: string[] = [];
      lines.push(`# ${doc.moduleName}`);
      lines.push("");
      lines.push(doc.description);
      lines.push("");

      if (doc.exports.length > 0) {
        lines.push("## Exports");
        lines.push("");
        lines.push("| Name | Type | Description |");
        lines.push("|------|------|-------------|");
        for (const exp of doc.exports) {
          lines.push(`| \`${exp.name}\` | ${exp.type} | ${exp.description.slice(0, 80)} |`);
        }
        lines.push("");
      }

      await writeFile(docPath, lines.join("\n"));
    } catch { /* skip */ }
  }

  console.log(`📚 Generated docs for ${modules.length} modules`);
  console.log(`📂 Docs directory: ${DOCS_DIR}`);
}

// Run if executed directly
if (process.argv[1]?.includes("doc-generator")) {
  runDocGeneration().then(() => {
    console.log("Done.");
  }).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
