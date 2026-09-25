import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FalVideoProvider, VideoGenerationService, type VideoGenerationProvider } from "../src/media/video-generation.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32)]);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("bounded video generation", () => {
  it("materializes base64 MP4 and supports confined image-to-video input", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-video-"));
    await writeFile(join(workspace, "source.png"), png);
    let sourceSeen = false;
    const provider: VideoGenerationProvider = {
      id: "fake",
      async generate(request) {
        sourceSeen = Boolean(request.sourceImage?.base64);
        return { model: "fake-video", video: { base64: mp4.toString("base64"), mimeType: "video/mp4" } };
      },
    };
    const service = new VideoGenerationService();
    service.register(provider, true);
    const result = await service.generate({
      workspacePath: workspace, prompt: "animate the pixel", sourcePath: "source.png", durationSeconds: 5,
    });
    expect(sourceSeen).toBe(true);
    expect(result.modality).toBe("image");
    expect(result.video.path).toMatch(/^\.haf\/artifacts\/videos\/.+\.mp4$/);
    expect(await readFile(join(workspace, result.video.path))).toEqual(mp4);
  });

  it("uses FAL key auth without URL leakage and maps normalized inputs", async () => {
    let url = ""; let headers: Headers; let body: any;
    globalThis.fetch = vi.fn(async (input, init) => {
      url = String(input); headers = new Headers(init?.headers); body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ video: { base64: mp4.toString("base64"), content_type: "video/mp4" } }), { status: 200 });
    }) as typeof fetch;
    const provider = new FalVideoProvider({ apiKey: "fal-secret", model: "fal-ai/test-video" });
    const response = await provider.generate({ prompt: "motion", aspectRatio: "portrait", durationSeconds: 7 });
    expect(url).toBe("https://fal.run/fal-ai/test-video");
    expect(url).not.toContain("fal-secret");
    expect(headers!.get("authorization")).toBe("Key fal-secret");
    expect(body).toEqual({ prompt: "motion", aspect_ratio: "9:16", duration: 7 });
    expect(response.video.base64).toBeTruthy();
  });

  it("rejects remote URLs by default, invalid video bytes and unsafe model IDs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-video-reject-"));
    const remote = new VideoGenerationService();
    remote.register({ id: "remote", async generate() { return { model: "x", video: { url: "https://example.com/video.mp4" } }; } }, true);
    await expect(remote.generate({ workspacePath: workspace, prompt: "x" })).rejects.toThrow("Remote video URLs are disabled");
    const invalid = new VideoGenerationService();
    invalid.register({ id: "invalid", async generate() { return { model: "x", video: { base64: Buffer.from("not-video").toString("base64") } }; } }, true);
    await expect(invalid.generate({ workspacePath: workspace, prompt: "x" })).rejects.toThrow("not a supported MP4");
    expect(() => new FalVideoProvider({ apiKey: "x", model: "../escape" })).toThrow("model ID");
  });
});
