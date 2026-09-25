import { createInterface, type Interface } from "node:readline";
import { AURORA_VIEWS, HafApiClient, type AuroraAction, type AuroraView, type SessionEvent } from "./client.js";

export async function runTui(client: HafApiClient): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("tui mode requires an interactive terminal; use rpc or run for headless automation.");
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 500, removeHistoryDuplicates: true });
  let sessionId: string | undefined;
  let subscription: AbortController | undefined;
  let chain = Promise.resolve();
  let multiline = false;
  let draft: string[] = [];
  let streamedText = false;
  let closed = false;

  const write = (value: string): void => { process.stdout.write(value); };
  const prompt = () => { terminal.setPrompt(sessionId ? `haf:${sessionId.slice(0, 8)}> ` : "haf> "); terminal.prompt(); };
  const stopSubscription = () => { subscription?.abort(); subscription = undefined; };
  const startSubscription = (id: string, afterSequence = 0) => {
    stopSubscription();
    const controller = new AbortController();
    subscription = controller;
    void client.subscribe(id, {
      afterSequence,
      signal: controller.signal,
      onEvent: (event) => renderEvent(event),
      onReconnect: ({ attempt, delayMs }) => { write(`\n[events reconnect ${attempt} in ${delayMs}ms]\n`); prompt(); },
    }).catch((error) => { if (!controller.signal.aborted) { write(`\n[event stream error: ${safe(error)}]\n`); prompt(); } });
  };
  const renderEvent = (event: SessionEvent) => {
    const payload = event.payload as any;
    if (event.type === "model.text.delta") { streamedText = true; write(String(payload?.delta ?? "")); return; }
    if (event.type === "model.reasoning.delta") return;
    if (event.type === "capability.started") { write(`\n[tool ${payload?.capabilityId ?? "unknown"} started]\n`); return; }
    if (event.type === "capability.finished") { write(`\n[tool ${payload?.capabilityId ?? "unknown"} ${payload?.status ?? "finished"}]\n`); return; }
    if (event.type === "session.status.changed") { write(`\n[status ${payload?.status ?? "unknown"}]\n`); return; }
    if (event.type === "approval.requested") { write(`\n[approval required ${payload?.approvalId ?? ""} ${payload?.capabilityId ?? ""}]\n`); }
  };

  const execute = async (line: string) => {
    const input = line.trim();
    if (multiline) {
      if (input === ".") {
        multiline = false;
        const text = draft.join("\n"); draft = [];
        if (text.trim()) await sendPrompt(text);
      } else draft.push(line);
      return;
    }
    if (!input) return;
    if (!input.startsWith("/")) return await sendPrompt(line);
    const [command, ...rest] = input.slice(1).split(/\s+/);
    const argument = rest.join(" ");
    switch (command) {
      case "help": showHelp(); break;
      case "new": {
        const session = await client.createSession({ ...(argument ? { name: argument } : {}) });
        sessionId = String(session.sessionId); startSubscription(sessionId, Number(session.sequence ?? 0));
        write(`[session ${sessionId}]\n`); break;
      }
      case "load": {
        if (!argument) throw new Error("Usage: /load <session-id>");
        const session = await client.getSession(argument); sessionId = String(session.sessionId); startSubscription(sessionId, Number(session.sequence ?? 0));
        write(`[loaded ${sessionId}]\n`); break;
      }
      case "sessions": {
        for (const item of await client.listSessions()) write(`${item.sessionId}\t${item.status}\t${item.name}\n`); break;
      }
      case "status": write(`${JSON.stringify(sessionId ? await client.getSession(sessionId) : await client.health(), null, 2)}\n`); break;
      case "events": {
        requireSession(sessionId); const events = await client.events(sessionId!, Math.max(0, Number(rest[0] ?? 0)), 100);
        for (const event of events) write(`${event.sequence}\t${event.type}\n`); break;
      }
      case "cancel": requireSession(sessionId); await client.command(sessionId!, "session.cancel", {}); break;
      case "pause": requireSession(sessionId); await client.command(sessionId!, "session.pause", {}); break;
      case "resume": requireSession(sessionId); await client.command(sessionId!, "session.resume", {}); break;
      case "compact": requireSession(sessionId); await client.command(sessionId!, "session.compact", {}); break;
      case "close": requireSession(sessionId); await client.command(sessionId!, "session.close", {}); stopSubscription(); sessionId = undefined; break;
      case "model": requireSession(sessionId); if (!argument) throw new Error("Usage: /model <provider:model>"); await client.command(sessionId!, "model.select", { model: argument, fallbackModels: [] }); break;
      case "approvals": {
        for (const item of await client.approvals(sessionId)) write(`${item.id}\t${item.status}\t${item.capabilityId}\t${item.reason}\n`); break;
      }
      case "approve": if (!argument) throw new Error("Usage: /approve <approval-id>"); await client.resolveApproval(argument, "approve_once"); break;
      case "approve-session": if (!argument) throw new Error("Usage: /approve-session <approval-id>"); await client.resolveApproval(argument, "approve_session"); break;
      case "deny": if (!argument) throw new Error("Usage: /deny <approval-id>"); await client.resolveApproval(argument, "deny"); break;
      case "aurora": {
        // The cognitive layer is reachable from the same terminal as the conversation: read-only
        // views by default, and only the same bounded actions the CLI exposes.
        if (!argument || argument === "help") {
          write(`views: ${Object.keys(AURORA_VIEWS).join(", ")}\nactions: cycle, autopilot-run-due, fleet-sweep, delegation-sync, harvest, decision-feedback-reconcile\n`);
          break;
        }
        const [target, ...flags] = argument.split(/\s+/);
        const actions: AuroraAction[] = ["cycle", "autopilot-run-due", "fleet-sweep", "delegation-sync", "harvest", "decision-feedback-reconcile"];
        const limitFlag = flags.indexOf("--limit");
        const limit = limitFlag >= 0 ? Number(flags[limitFlag + 1]) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new Error("--limit must be an integer between 1 and 1000.");
        const value = actions.includes(target as AuroraAction)
          ? await client.auroraAction(target as AuroraAction)
          : await client.auroraView(target as AuroraView, limit !== undefined ? { limit } : {});
        write(`${JSON.stringify(value, null, 2)}\n`);
        break;
      }
      case "multi": multiline = true; draft = []; write("[multiline mode; enter a single . to submit]\n"); break;
      case "quit": case "exit": stopSubscription(); terminal.close(); break;
      default: throw new Error(`Unknown command /${command}; use /help.`);
    }
  };
  const sendPrompt = async (text: string) => {
    if (!sessionId) {
      const session = await client.createSession({ name: "TUI session" });
      sessionId = String(session.sessionId); startSubscription(sessionId, Number(session.sequence ?? 0));
      write(`[session ${sessionId}]\n`);
    }
    streamedText = false;
    const result = await client.prompt(sessionId, text);
    if (streamedText) write("\n");
    if (result?.status !== "completed") write(`[command ${result?.status ?? "unknown"}]\n`);
  };

  terminal.on("close", () => { closed = true; });
  terminal.on("line", (line) => {
    chain = chain.then(() => execute(line)).catch((error) => { write(`[error: ${safe(error)}]\n`); }).finally(() => { if (!closed) prompt(); });
  });
  terminal.on("SIGINT", () => {
    if (multiline) { multiline = false; draft = []; write("\n[multiline cancelled]\n"); prompt(); return; }
    if (sessionId) void client.command(sessionId, "session.cancel", {}).catch(() => undefined);
  });
  write("Hybrid Agent Fabric TUI 1.46.0 — /help for commands\n");
  prompt();
  await new Promise<void>((resolve) => terminal.once("close", resolve));
  stopSubscription();
  await chain;
}

function showHelp(): void {
  process.stdout.write([
    "/new [name]       create a session", "/load <id>       load a session", "/sessions        list sessions",
    "/status          show health/session", "/events [seq]    recent event metadata", "/multi           multiline prompt; . submits",
    "/model <route>   select provider:model", "/pause /resume /cancel /compact /close", "/approvals       list approvals",
    "/approve <id> /approve-session <id> /deny <id>",
    "/aurora [view|action] [--limit N]   Aurora status, alerts, delegations, fleet, harvest (/aurora help)",
    "/quit", "Plain input sends a prompt.", "",
  ].join("\n"));
}
function requireSession(value: string | undefined): asserts value is string { if (!value) throw new Error("Create or load a session first."); }
function safe(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500); }
