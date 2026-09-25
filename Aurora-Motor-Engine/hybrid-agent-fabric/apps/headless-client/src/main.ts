#!/usr/bin/env node
import { createInterface } from "node:readline";
import { AURORA_VIEWS, HafApiClient, type AuroraAction, type AuroraView } from "./client.js";
import { HeadlessRpcServer } from "./rpc.js";
import { runTui } from "./tui.js";

const args = process.argv.slice(2);
const mode = args[0] ?? (process.stdin.isTTY ? "tui" : "rpc");
const client = new HafApiClient({
  baseUrl: process.env.HAF_URL ?? "http://127.0.0.1:8787",
  ...(process.env.HAF_API_TOKEN ? { token: process.env.HAF_API_TOKEN } : {}),
  tenantId: process.env.HAF_TENANT ?? "local",
  requestTimeoutMs: environmentInteger("HAF_CLIENT_TIMEOUT_MS", 30_000, 1_000, 600_000),
});

if (mode === "rpc") await runRpc(client);
else if (mode === "tui") await runTui(client);
else if (mode === "run") await runOnce(client, args.slice(1));
else if (mode === "aurora") await runAurora(client, args.slice(1));
else if (mode === "help" || mode === "--help" || mode === "-h") usage();
else throw new Error(`Unknown mode ${mode}; expected rpc, tui, run or aurora.`);

async function runRpc(api: HafApiClient): Promise<void> {
  const rpc = new HeadlessRpcServer(api, (message) => process.stdout.write(`${JSON.stringify(message)}\n`));
  const input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  let chain = Promise.resolve();
  input.on("line", (line) => { chain = chain.then(() => rpc.handleLine(line)); });
  await new Promise<void>((resolve) => input.once("close", resolve));
  await chain;
  await rpc.shutdown();
}

async function runOnce(api: HafApiClient, options: string[]): Promise<void> {
  let sessionId: string | undefined;
  let name: string | undefined;
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (option === "--session") sessionId = requiredOption(options[++index], "--session");
    else if (option === "--name") name = requiredOption(options[++index], "--name");
    else throw new Error(`Unknown run option ${option}. Prompt content must be provided on stdin, never as a process argument.`);
  }
  const prompt = await readStdin(1024 * 1024);
  if (!prompt.trim()) throw new Error("run mode expects prompt text on stdin.");
  if (!sessionId) sessionId = String((await api.createSession({ ...(name ? { name } : {}) })).sessionId);
  const command = await api.prompt(sessionId, prompt);
  const session = await api.getSession(sessionId);
  const assistant = [...(session.messages ?? [])].reverse().find((message: any) => message.role === "assistant");
  const text = assistant?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
  process.stdout.write(`${JSON.stringify({ sessionId, command, response: text, usage: session.totalUsage ?? null })}\n`);
}

/**
 * Aurora operations from the terminal: the cognitive layer is only trustworthy if an operator can
 * inspect it without a browser. Views are read-only and allowlisted; the three actions are the same
 * bounded, governed operations the Control API exposes.
 */
async function runAurora(api: HafApiClient, options: string[]): Promise<void> {
  const target = options[0];
  if (!target || target === "help") {
    process.stdout.write(`Aurora views: ${Object.keys(AURORA_VIEWS).join(", ")}\nAurora actions: cycle [--mode MODE], autopilot-run-due, fleet-sweep, delegation-sync, harvest, decision-feedback-reconcile\n`);
    return;
  }
  let limit: number | undefined;
  let cycleMode: string | undefined;
  for (let index = 1; index < options.length; index++) {
    const option = options[index];
    if (option === "--limit") limit = Number(requiredOption(options[++index], "--limit"));
    else if (option === "--mode") cycleMode = requiredOption(options[++index], "--mode");
    else throw new Error(`Unknown aurora option ${option}.`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new Error("--limit must be an integer between 1 and 1000.");
  const actions: AuroraAction[] = ["cycle", "autopilot-run-due", "fleet-sweep", "delegation-sync", "harvest", "decision-feedback-reconcile"];
  const result = actions.includes(target as AuroraAction)
    ? await api.auroraAction(target as AuroraAction, cycleMode !== undefined ? { mode: cycleMode } : {})
    : await api.auroraView(target as AuroraView, limit !== undefined ? { limit } : {});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function usage(): void {
  process.stdout.write(`Hybrid Agent Fabric client 1.46.0\n\n` +
    `  haf-client tui\n  haf-client rpc\n  printf 'prompt' | haf-client run [--session ID] [--name NAME]\n` +
    `  haf-client aurora VIEW|ACTION [--limit N] [--mode MODE]   (haf-client aurora help lists them)\n\n` +
    `Environment: HAF_URL, HAF_API_TOKEN, HAF_TENANT, HAF_CLIENT_TIMEOUT_MS\n` +
    `Credentials and prompt text are intentionally not accepted as command-line flags.\n`);
}
function environmentInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
function requiredOption(value: string | undefined, name: string): string {
  if (!value || value.startsWith("--") || value.length > 500) throw new Error(`${name} requires a value.`);
  return value;
}
async function readStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`stdin exceeds ${maxBytes} bytes.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
