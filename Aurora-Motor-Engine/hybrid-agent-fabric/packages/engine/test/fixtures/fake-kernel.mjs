#!/usr/bin/env node
/**
 * Fake Python kernel — test fixture.
 *
 * Speaks the v2 generation-fenced kernel protocol over NDJSON on stdio so the
 * host-request security rules can be exercised without a real Python runtime.
 *
 * Supported `execute` payloads (selected by the `code` string):
 *   "duplicate" — emits the SAME host_request twice; the client must
 *                 deduplicate by generation/execution/request id.
 *   "stale"     — emits a host_request with a bogus token and generation; the
 *                 client must reject it before reaching the capability handler.
 *   "hang"      — never replies, so cancellation/kill behaviour can be tested.
 *   anything else — echoes immediately.
 */

import { createInterface } from "node:readline";

const write = (frame) => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

// Announce protocol v2 readiness.
write({ type: "ready", pid: process.pid, protocolVersion: 2 });

/** Pending host responses keyed by requestId, per execution. */
const awaitingHostResponse = new Map();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;

  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }

  if (frame.type === "host_response") {
    const pending = awaitingHostResponse.get(frame.requestId);
    if (pending) {
      awaitingHostResponse.delete(frame.requestId);
      pending(frame);
    }
    return;
  }

  if (frame.type !== "execute") return;

  const { id, code, executionId, kernelGeneration, hostToken } = frame;

  if (code === "hang") {
    // Deliberately never respond: the client must cancel and kill us.
    return;
  }

  if (code === "duplicate") {
    const requestId = "host-request-1";
    let responses = 0;

    const onResponse = (response) => {
      responses += 1;
      // Reply only after the first (deduplicated) response comes back.
      write({
        type: "result",
        id,
        executionId,
        ok: true,
        stdout: "",
        stderr: "",
        result: response.ok ? `accepted:${responses}` : `rejected:${response.error}`,
        resultType: "str",
      });
    };

    awaitingHostResponse.set(requestId, onResponse);

    const hostRequest = {
      type: "host_request",
      requestId,
      executionId,
      kernelGeneration,
      hostToken,
      capability: "test.capability",
      arguments: { probe: true },
    };

    // Emit the identical frame twice — the client must only invoke the
    // capability handler once.
    write(hostRequest);
    write(hostRequest);
    return;
  }

  if (code === "stale") {
    const requestId = "host-request-stale";

    awaitingHostResponse.set(requestId, (response) => {
      write({
        type: "result",
        id,
        executionId,
        ok: true,
        stdout: "",
        stderr: "",
        result: response.ok ? "accepted" : String(response.error),
        resultType: "str",
      });
    });

    // Wrong generation AND wrong token: must be refused before the handler.
    write({
      type: "host_request",
      requestId,
      executionId,
      kernelGeneration: "00000000-0000-0000-0000-000000000000",
      hostToken: "not-the-real-token",
      capability: "test.capability",
      arguments: {},
    });
    return;
  }

  write({
    type: "result",
    id,
    executionId,
    ok: true,
    stdout: "",
    stderr: "",
    result: String(code ?? ""),
    resultType: "str",
  });
});

rl.on("close", () => process.exit(0));
