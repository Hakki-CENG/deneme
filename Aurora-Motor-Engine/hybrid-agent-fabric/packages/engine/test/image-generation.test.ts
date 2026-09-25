import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageGenerationService, OpenAIImageProvider, type ImageGenerationProvider } from "../src/media/image-generation.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("image generation artifacts", () => {
  it("requests base64 output and materializes a bounded raster inside the workspace", async () => {
    let requestBody: any;
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: [{ b64_json: png, revised_prompt: "revised" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const workspace = await mkdtemp(join(tmpdir(), "haf-image-"));
    const service = new ImageGenerationService();
    service.register(new OpenAIImageProvider({ apiKey: "image-secret", model: "image-test" }), true);
    const result = await service.generate({ workspacePath: workspace, prompt: "a safe diagram", aspectRatio: "square" });
    expect(requestBody.response_format).toBe("b64_json");
    expect(requestBody.size).toBe("1024x1024");
    expect(result.images[0]?.path).toMatch(/^\.haf\/artifacts\/images\/.+\.png$/);
    const bytes = await readFile(join(workspace, result.images[0]!.path));
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(result.images[0]?.revisedPrompt).toBe("revised");
  });

  it("confines and validates an edit source before using the multipart edits endpoint", async () => {
    let requestUrl = "";
    let form: FormData | undefined;
    globalThis.fetch = vi.fn(async (url, init) => {
      requestUrl = String(url);
      form = init?.body as FormData;
      return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const workspace = await mkdtemp(join(tmpdir(), "haf-image-edit-"));
    await writeFile(join(workspace, "source.png"), Buffer.from(png, "base64"));
    const service = new ImageGenerationService();
    service.register(new OpenAIImageProvider({ apiKey: "image-secret", model: "edit-model" }), true);
    const result = await service.generate({ workspacePath: workspace, prompt: "make the background blue", sourcePath: "source.png" });
    expect(requestUrl).toContain("/images/edits");
    expect(form?.get("prompt")).toBe("make the background blue");
    expect(form?.get("image")).toBeInstanceOf(Blob);
    expect(result.modality).toBe("edit");
    await writeFile(join(workspace, "..", "outside.png"), Buffer.from(png, "base64"));
    await expect(service.generate({ workspacePath: workspace, prompt: "escape", sourcePath: "../outside.png" })).rejects.toThrow("escapes the workspace");
  });

  it("rejects remote provider URLs by default and rejects non-image base64", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-image-reject-"));
    const remote: ImageGenerationProvider = {
      id: "remote",
      async generate() { return { model: "remote", images: [{ url: "https://example.com/image.png" }] }; },
    };
    const service = new ImageGenerationService();
    service.register(remote, true);
    await expect(service.generate({ workspacePath: workspace, prompt: "x" })).rejects.toThrow("Remote image URLs are disabled");

    const fake: ImageGenerationProvider = {
      id: "fake",
      async generate() { return { model: "fake", images: [{ base64: Buffer.from("<script>alert(1)</script>").toString("base64") }] }; },
    };
    const invalid = new ImageGenerationService();
    invalid.register(fake, true);
    await expect(invalid.generate({ workspacePath: workspace, prompt: "x" })).rejects.toThrow("not a supported PNG");
  });
});
