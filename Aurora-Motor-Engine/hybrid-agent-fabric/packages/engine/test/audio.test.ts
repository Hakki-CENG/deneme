import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioService } from "../src/audio/audio-service.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("workspace-confined STT/TTS", () => {
  it("transcribes a bounded workspace file without exposing the provider key", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-audio-"));
    await writeFile(join(workspace, "memo.wav"), Buffer.from("fake-wave"));
    let authorization = "";
    globalThis.fetch = vi.fn(async (_url, init) => {
      authorization = (init?.headers as Record<string, string>).authorization;
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ text: "hello world" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const service = new AudioService({ apiKey: "audio-secret", transcriptionModel: "whisper-test" });
    const transcribed = await service.transcribe({ workspacePath: workspace, path: "memo.wav" });
    expect(transcribed).toMatchObject({ text: "hello world", model: "whisper-test" });
    expect(typeof transcribed.durationMs).toBe("number"); // P2.21 measured latency
    expect(authorization).toBe("Bearer audio-secret");
    await expect(service.transcribe({ workspacePath: workspace, path: "../outside.wav" })).rejects.toThrow();
  });

  it("writes synthesized audio only inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-audio-"));
    globalThis.fetch = vi.fn(async () => new Response(Buffer.from("audio-bytes"), { status: 200 })) as typeof fetch;
    const service = new AudioService({ apiKey: "secret", speechModel: "tts-test", defaultVoice: "voice-test" });
    const result = await service.synthesize({ workspacePath: workspace, text: "hello", outputPath: "artifacts/hello.mp3" });
    expect(result).toMatchObject({ path: "artifacts/hello.mp3", model: "tts-test", voice: "voice-test" });
    expect(typeof result.durationMs).toBe("number"); // P2.21 measured latency
    expect((await readFile(join(workspace, "artifacts/hello.mp3"))).toString()).toBe("audio-bytes");
    await expect(service.synthesize({ workspacePath: workspace, text: "bad", outputPath: "../../escape.mp3" })).rejects.toThrow("escapes");
  });
});
