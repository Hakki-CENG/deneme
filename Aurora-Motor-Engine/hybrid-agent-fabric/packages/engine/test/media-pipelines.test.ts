import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FalImageProvider, FalImageUpscaleProvider, ImageGenerationService, OpenAIImageProvider,
  type ImageGenerationProvider, type ImageUpscaleProvider,
} from "../src/media/image-generation.js";
import { FalVideoProvider, VideoGenerationService, type VideoGenerationProvider } from "../src/media/video-generation.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32)]);
function sizedPng(width: number, height: number): Buffer { const value = Buffer.from(png); value.writeUInt32BE(width, 16); value.writeUInt32BE(height, 20); return value; }

describe("multi-reference media and image upscaling pipelines", () => {
  it("sends multiple confined OpenAI edit references and reports multi-reference modality", async () => {
    let form: FormData | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      form = init?.body as FormData;
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    }) as typeof fetch;
    const workspace = await mkdtemp(join(tmpdir(), "haf-multi-image-"));
    await writeFile(join(workspace, "a.png"), png); await writeFile(join(workspace, "b.png"), png);
    const service = new ImageGenerationService();
    service.register(new OpenAIImageProvider({ apiKey: "secret", model: "gpt-image-test" }), true);
    const result = await service.generate({ workspacePath: workspace, prompt: "combine both references", sourcePaths: ["a.png", "b.png"] });
    expect(form?.getAll("image[]")).toHaveLength(2);
    expect(form?.getAll("image[]").every((item) => item instanceof Blob)).toBe(true);
    expect(result.modality).toBe("multi-reference");
    expect(result.pipeline).toEqual([{ provider: "openai-images", operation: "edit", model: "gpt-image-test" }]);
    await expect(service.generate({ workspacePath: workspace, prompt: "duplicates", sourcePaths: ["a.png", "a.png"] })).rejects.toThrow("unique");
  });

  it("chains FAL multi-reference generation into verified 2x upscale and supports direct upscale", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-fal-pipeline-"));
    await writeFile(join(workspace, "a.png"), png); await writeFile(join(workspace, "b.png"), png);
    const bodies: Array<{ url: string; body: any; authorization: string }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input), body = JSON.parse(String(init?.body));
      bodies.push({ url, body, authorization: new Headers(init?.headers).get("authorization") ?? "" });
      if (url.endsWith("/fal-ai/upscale")) return Response.json({ image: { base64: sizedPng(2, 2).toString("base64") } });
      return Response.json({ images: [{ base64: png.toString("base64") }] });
    }) as typeof fetch;
    const service = new ImageGenerationService();
    service.register(new FalImageProvider({ apiKey: "fal-secret", model: "fal-ai/generate", editModel: "fal-ai/edit" }), true);
    service.registerUpscaler(new FalImageUpscaleProvider({ apiKey: "fal-secret", model: "fal-ai/upscale" }));
    const result = await service.generate({
      workspacePath: workspace, prompt: "merge and enhance", sourcePaths: ["a.png", "b.png"],
      upscale: { providerId: "fal-upscale", scale: 2 },
    });
    expect(result.modality).toBe("multi-reference");
    expect(result.pipeline.map((item) => item.operation)).toEqual(["edit", "upscale"]);
    expect(bodies[0]?.url).toBe("https://fal.run/fal-ai/edit");
    expect(bodies[0]?.body.image_urls).toHaveLength(2);
    expect(bodies.every((item) => item.authorization === "Key fal-secret")).toBe(true);
    expect(JSON.stringify(bodies.map((item) => item.body))).not.toContain("fal-secret");
    const final = await readFile(join(workspace, result.images[0]!.path));
    expect(final.readUInt32BE(16)).toBe(2);
    const direct = await service.upscale({ workspacePath: workspace, sourcePath: "a.png", providerId: "fal-upscale", scale: 2 });
    expect(direct.image.path).toContain("upscaled");
  });

  it("rejects fake upscalers that do not meet the requested dimensions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-upscale-reject-")); await writeFile(join(workspace, "a.png"), png);
    const provider: ImageUpscaleProvider = { id: "fake-upscale", async upscale() { return { model: "fake", image: { base64: png.toString("base64") } }; } };
    const service = new ImageGenerationService(); service.registerUpscaler(provider);
    await expect(service.upscale({ workspacePath: workspace, sourcePath: "a.png", providerId: "fake-upscale", scale: 2 })).rejects.toThrow("2x source dimensions");
  });

  it("projects up to four video references and maps FAL image_urls without credential leakage", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-multi-video-"));
    await writeFile(join(workspace, "a.png"), png); await writeFile(join(workspace, "b.png"), png);
    let seenReferences = 0;
    const fake: VideoGenerationProvider = {
      id: "multi-video", supportsMultiReference: true,
      async generate(request) { seenReferences = request.sourceImages?.length ?? 0; return { model: "multi", video: { base64: mp4.toString("base64") } }; },
    };
    const service = new VideoGenerationService(); service.register(fake, true);
    const result = await service.generate({ workspacePath: workspace, prompt: "animate", sourcePaths: ["a.png", "b.png"] });
    expect(seenReferences).toBe(2); expect(result.modality).toBe("multi-reference"); expect(result.references).toBe(2);

    let body: any; let auth = "";
    globalThis.fetch = vi.fn(async (_input, init) => { body = JSON.parse(String(init?.body)); auth = new Headers(init?.headers).get("authorization") ?? ""; return Response.json({ video: { base64: mp4.toString("base64") } }); }) as typeof fetch;
    const fal = new FalVideoProvider({ apiKey: "video-secret", model: "fal-ai/video" });
    await fal.generate({ prompt: "animate", aspectRatio: "square", sourceImages: [
      { base64: png.toString("base64"), mimeType: "image/png" }, { base64: png.toString("base64"), mimeType: "image/png" },
    ] });
    expect(body.image_urls).toHaveLength(2); expect(body.image_url).toBeUndefined(); expect(auth).toBe("Key video-secret"); expect(JSON.stringify(body)).not.toContain("video-secret");
  });
});
