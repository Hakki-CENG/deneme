import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandJournal } from "../src/persistence/command-journal.js";
import type { CommandEnvelope } from "../src/types.js";

const command: CommandEnvelope = {
  protocolVersion: 1,
  commandId: "command-1",
  clientId: "client",
  tenantId: "tenant",
  sessionId: "session",
  kind: "session.pause",
  source: "api",
  issuedAt: new Date().toISOString(),
  payload: {},
};

describe("command journal", () => {
  it("returns the durable result for duplicate commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-journal-"));
    const journal = new CommandJournal(root);
    let executions = 0;
    const operation = async () => {
      executions++;
      return { commandId: command.commandId, status: "completed" as const, result: { value: executions } };
    };
    const first = await journal.execute(command, operation);
    const second = await journal.execute(command, operation);
    expect(first).toEqual(second);
    expect(executions).toBe(1);

    const reloaded = new CommandJournal(root);
    expect(await reloaded.execute(command, operation)).toEqual(first);
    expect(executions).toBe(1);
  });
});
