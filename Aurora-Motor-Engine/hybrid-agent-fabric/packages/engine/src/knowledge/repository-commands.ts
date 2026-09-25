import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { auroraDigest, auroraInteger, auroraText } from "../util/aurora-state.js";

const COMMAND_DIRECTORIES = [".aurora/commands", ".claude/commands", ".codex/prompts", ".github/prompts"] as const;
const MAX_COMMANDS = 200;
const MAX_COMMAND_BYTES = 64 * 1024;

/** Same screening vocabulary as instruction files: a command template is prompt content too. */
const INJECTION_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "instruction-override", pattern: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)\b/i },
  { code: "policy-bypass", pattern: /\b(bypass|disable|skip|ignore)\s+(the\s+)?(policy|approval|guardrail|safety|sandbox|constitution)\b/i },
  { code: "credential-exfiltration", pattern: /\b(api[_\s-]?key|secret|token|password|credential)s?\b[^\n]{0,40}\b(send|post|upload|exfiltrate|share|email)\b/i },
  { code: "autonomy-escalation", pattern: /\b(always|never)\s+(auto[- ]?approve|approve\s+everything|run\s+without\s+asking)\b/i },
];

export interface RepositoryCommand {
  name: string;
  path: string;
  source: string;
  description: string;
  body: string;
  /** Placeholders the template uses: `$ARGUMENTS`, `$1`, `$2`, … */
  parameters: string[];
  bytes: number;
  digest: string;
  screened: boolean;
  screeningFindings: string[];
}

export interface RenderedCommand {
  name: string;
  path: string;
  text: string;
  characters: number;
  digest: string;
  substituted: Array<{ placeholder: string; characters: number }>;
  unresolved: string[];
  generatedAt: string;
}

/**
 * Repository-local command templates — the `.claude/commands` / Codex prompts convention.
 *
 * A team's repeated instructions belong in the repository, not in everybody's shell history. Aurora
 * reads the same folders the peers do (`.aurora/commands`, `.claude/commands`, `.codex/prompts`,
 * `.github/prompts`) so an existing repository works without migration, and applies the same rules it
 * applies to every other piece of untrusted repository content:
 *
 * - bounded discovery (command count, file size), path-confined, symlinks refused;
 * - injection screening, with a suspicious template refused at render time rather than quarantined
 *   quietly — a command is *invoked deliberately*, so the caller deserves a hard error, not silence;
 * - substitution is explicit and reported: `$ARGUMENTS` plus positional `$1`…`$9`, with every
 *   placeholder that was filled and every one left unresolved listed in the result;
 * - rendering produces text for a human or an agent to send. It never executes anything by itself.
 */
export class RepositoryCommandService {
  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: { maxCommands?: number; maxCommandBytes?: number } = {},
  ) {}

  async list(workspacePath: string): Promise<{ workspacePath: string; commands: RepositoryCommand[]; skipped: Array<{ path: string; reason: string }>; generatedAt: string }> {
    const root = resolve(auroraText(workspacePath, 4096, "Workspace path"));
    if (!isAbsolute(root)) throw new Error("Workspace path must be absolute.");
    const maxCommands = auroraInteger(this.options.maxCommands ?? MAX_COMMANDS, 1, 1000, "Command limit");
    const maxBytes = auroraInteger(this.options.maxCommandBytes ?? MAX_COMMAND_BYTES, 64, 1024 * 1024, "Command size limit");
    const commands: RepositoryCommand[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (const directory of COMMAND_DIRECTORIES) {
      const absolute = join(root, directory);
      let entries;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (commands.length >= maxCommands) { skipped.push({ path: `${directory}/${entry.name}`, reason: "command-limit-reached" }); continue; }
        const absolutePath = join(absolute, entry.name);
        const relativePath = relative(root, absolutePath).split(sep).join("/");
        if (relativePath.startsWith("..") || isAbsolute(relativePath)) { skipped.push({ path: relativePath, reason: "outside-workspace" }); continue; }
        if (entry.isSymbolicLink()) { skipped.push({ path: relativePath, reason: "symlink-refused" }); continue; }
        if (!entry.isFile() || !/\.(md|markdown|txt|prompt)$/i.test(entry.name)) continue;

        let info;
        try {
          info = await stat(absolutePath);
        } catch {
          continue;
        }
        if (info.size > maxBytes) { skipped.push({ path: relativePath, reason: `too-large (${info.size} bytes)` }); continue; }

        let raw: string;
        try {
          raw = await readFile(absolutePath, "utf8");
        } catch {
          skipped.push({ path: relativePath, reason: "unreadable" });
          continue;
        }
        const name = entry.name.replace(/\.(md|markdown|txt|prompt)$/i, "").toLowerCase();
        if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(name)) { skipped.push({ path: relativePath, reason: "invalid-command-name" }); continue; }
        if (commands.some((item) => item.name === name)) { skipped.push({ path: relativePath, reason: `shadowed by ${commands.find((item) => item.name === name)!.path}` }); continue; }

        const { description, body } = splitFrontMatter(raw);
        const findings = INJECTION_PATTERNS.filter((item) => item.pattern.test(raw)).map((item) => item.code);
        commands.push({
          name,
          path: relativePath,
          source: directory,
          description,
          body,
          parameters: [...new Set([...body.matchAll(/\$(ARGUMENTS|[1-9])/g)].map((match) => `$${match[1]}`))],
          bytes: info.size,
          digest: auroraDigest(raw),
          screened: findings.length === 0,
          screeningFindings: findings,
        });
      }
    }

    commands.sort((a, b) => a.name.localeCompare(b.name));
    return { workspacePath: root, commands, skipped, generatedAt: new Date(this.now()).toISOString() };
  }

  /**
   * Render one command with arguments. A screened-out template is refused loudly: a command is
   * invoked on purpose, so silently returning nothing would be worse than an error.
   */
  async render(input: { workspacePath: string; name: string; arguments?: string[] }): Promise<RenderedCommand> {
    const name = auroraText(input.name, 60, "Command name").toLowerCase();
    const { commands } = await this.list(input.workspacePath);
    const command = commands.find((item) => item.name === name);
    if (!command) throw new Error(`Repository command "${name}" not found. Known commands: ${commands.map((item) => item.name).join(", ") || "none"}.`);
    if (!command.screened) throw new Error(`Repository command "${name}" failed injection screening (${command.screeningFindings.join(", ")}) and will not be rendered.`);

    const args = (input.arguments ?? []).map((item) => auroraText(item, 10_000, "Command argument"));
    const substituted: RenderedCommand["substituted"] = [];
    let text = command.body;

    const all = args.join(" ");
    if (text.includes("$ARGUMENTS")) {
      text = text.split("$ARGUMENTS").join(all);
      substituted.push({ placeholder: "$ARGUMENTS", characters: all.length });
    }
    for (let index = 1; index <= 9; index++) {
      const placeholder = `$${index}`;
      if (!text.includes(placeholder)) continue;
      const value = args[index - 1] ?? "";
      text = text.split(placeholder).join(value);
      substituted.push({ placeholder, characters: value.length });
    }
    const unresolved = [...new Set([...text.matchAll(/\$(ARGUMENTS|[1-9])/g)].map((match) => `$${match[1]}`))];

    return {
      name: command.name,
      path: command.path,
      text,
      characters: text.length,
      digest: auroraDigest(text),
      substituted,
      unresolved,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }
}

/** Minimal front matter: an optional `description:` line, then the template body. */
function splitFrontMatter(raw: string): { description: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? "";
    return { description: firstLine.replace(/^#+\s*/, "").slice(0, 300), body: raw.trim() };
  }
  const front = match[1] ?? "";
  const description = (front.split("\n").find((line) => line.toLowerCase().startsWith("description:")) ?? "")
    .slice("description:".length).trim().slice(0, 300);
  return { description, body: raw.slice(match[0].length).trim() };
}
