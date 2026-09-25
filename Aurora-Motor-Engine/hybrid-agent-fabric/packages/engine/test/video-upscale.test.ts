import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FalVideoUpscaleProvider, VideoGenerationService, type VideoUpscaleProvider } from "../src/media/video-generation.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function box(type: string, payload: Buffer): Buffer {
  const output = Buffer.alloc(8 + payload.length); output.writeUInt32BE(output.length, 0); output.write(type, 4, 4, "ascii"); payload.copy(output, 8); return output;
}
function mp4(width: number, height: number): Buffer {
  const ftyp = box("ftyp", Buffer.from("isom0000", "ascii"));
  const tkhdPayload = Buffer.alloc(20); tkhdPayload.writeUInt32BE(width * 65536, 12); tkhdPayload.writeUInt32BE(height * 65536, 16);
  return Buffer.concat([ftyp, box("moov", box("trak", box("tkhd", tkhdPayload)))]);
}

describe("verified video upscaling", () => {
  it("sends confined video bytes to FAL and materializes a dimension-verified 2x MP4", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-video-upscale-"));
    await writeFile(join(workspace, "source.mp4"), mp4(320, 180));
    let url = "", body: any, auth = "";
    globalThis.fetch = vi.fn(async (input, init) => {
      url = String(input); body = JSON.parse(String(init?.body)); auth = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ video: { base64: mp4(640, 360).toString("base64"), content_type: "video/mp4" } });
    }) as typeof fetch;
    const service = new VideoGenerationService();
    service.registerUpscaler(new FalVideoUpscaleProvider({ apiKey: "video-upscale-secret", model: "fal-ai/video-upscale" }));
    const result = await service.upscale({ workspacePath: workspace, sourcePath: "source.mp4", providerId: "fal-video-upscale", scale: 2 });
    expect(url).toBe("https://fal.run/fal-ai/video-upscale");
    expect(auth).toBe("Key video-upscale-secret");
    expect(body.scale).toBe(2); expect(body.upscale_factor).toBe(2);
    expect(body.video_url).toMatch(/^data:video\/mp4;base64,/);
    expect(JSON.stringify(body)).not.toContain("video-upscale-secret");
    expect(result.video).toMatchObject({ width: 640, height: 360, mimeType: "video/mp4" });
    expect(await readFile(join(workspace, result.video.path))).toEqual(mp4(640, 360));
  });

  it("rejects provider outputs below the requested factor and source path escape", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-video-upscale-reject-"));
    await writeFile(join(workspace, "source.mp4"), mp4(320, 180));
    await writeFile(join(workspace, "..", "outside.mp4"), mp4(320, 180));
    const fake: VideoUpscaleProvider = { id: "fake", async upscale() { return { model: "fake", video: { base64: mp4(500, 300).toString("base64") } }; } };
    const service = new VideoGenerationService(); service.registerUpscaler(fake);
    await expect(service.upscale({ workspacePath: workspace, sourcePath: "source.mp4", providerId: "fake", scale: 2 })).rejects.toThrow("2x source dimensions");
    await expect(service.upscale({ workspacePath: workspace, sourcePath: "../outside.mp4", providerId: "fake", scale: 2 })).rejects.toThrow("escapes the workspace");
  });

  it("rejects redirects and unsafe FAL model identifiers", async () => {
    expect(() => new FalVideoUpscaleProvider({ apiKey: "x", model: "../escape" })).toThrow("model ID");
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as typeof fetch;
    const provider = new FalVideoUpscaleProvider({ apiKey: "x", model: "fal-ai/upscale" });
    await expect(provider.upscale({ video: { bytes: mp4(10, 10), mimeType: "video/mp4", fileName: "a.mp4" }, scale: 2 })).rejects.toThrow("redirects are forbidden");
  });
});
