import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerProtocolServer } from "../src/runtime/worker/worker-server.js";
import { WorkerProtocolClient } from "../src/runtime/worker/worker-client.js";
import { WorkerFrameDecoder, encodeWorkerFrame } from "../src/runtime/worker/framing.js";

describe("private worker protocol", () => {
  it("decodes fragmented binary frames and multiple coalesced frames", () => {
    const decoder = new WorkerFrameDecoder();
    const first = encodeWorkerFrame({ type: "one", requestId: "1" }, "hello");
    const second = encodeWorkerFrame({ type: "two" }, "world");
    expect(decoder.push(first.subarray(0, 5))).toEqual([]);
    const frames = decoder.push(Buffer.concat([first.subarray(5), second]));
    expect(frames.map((frame) => [frame.header.type, frame.payload.toString()])).toEqual([["one", "hello"], ["two", "world"]]);
  });

  it("authenticates, executes commands, replays events and falls back to chunked snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-worker-protocol-"));
    let value = 0;
    const snapshotValue = { state: "x".repeat(100_000) };
    const server = new WorkerProtocolServer({
      workerId: "worker-1",
      socketPath: join(root, "worker.sock"),
      descriptorPath: join(root, "worker.json"),
      token: "test-token",
      replayCapacity: 2,
      snapshotChunkBytes: 16_384,
      commandHandler: async (method, payload) => {
        if (method === "increment") value += JSON.parse(payload.toString()).by;
        if (method === "get") return { value };
        return { value };
      },
      snapshotProvider: async () => snapshotValue,
    });
    const descriptor = await server.start();
    const client = new WorkerProtocolClient(descriptor);
    await client.connect();
    expect(JSON.parse((await client.command("increment", { by: 2 })).toString())).toEqual({ value: 2 });

    const seen: number[] = [];
    const delivered = new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("worker events were not delivered before timeout")), 1000);
      client.onEvent((event) => {
        seen.push(event.cursor.sequence);
        if (seen.length === 2) { clearTimeout(timer); resolvePromise(); }
      });
    });
    server.publish("a", { a: 1 });
    server.publish("b", { b: 2 });
    await delivered;
    expect(seen).toEqual([1, 2]);

    client.close();
    server.publish("c", { c: 3 }); // evicts sequence 1 from replay
    const adopted = await WorkerProtocolClient.fromDescriptorFile(join(root, "worker.json"));
    await adopted.connect();
    const replay = await adopted.attach({ generation: 1, sequence: 2 });
    expect(replay.replay).toBe("complete");
    const unavailable = await adopted.attach({ generation: 0, sequence: 0 });
    expect(unavailable.replay).toBe("unavailable");
    expect(JSON.parse(unavailable.snapshot!.toString())).toEqual(snapshotValue);
    adopted.close();
    await server.stop();
  });
});
