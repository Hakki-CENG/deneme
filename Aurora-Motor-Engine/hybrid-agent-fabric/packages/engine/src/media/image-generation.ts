import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { assertSafeUrl, readBoundedBody } from "../capabilities/web.js";
import { modelHttpError } from "../models/model-provider-error.js";

export type ImageAspectRatio = "landscape" | "square" | "portrait";

export interface ImageInput {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  aspectRatio: ImageAspectRatio;
  count: number;
  model?: string;
  sourceImage?: ImageInput;
  sourceImages?: ImageInput[];
  signal?: AbortSignal;
}

export interface ImageUpscaleRequest {
  image: ImageInput;
  scale: 2 | 4;
  signal?: AbortSignal;
}

export interface GeneratedImageSource {
  base64?: string;
  url?: string;
  revisedPrompt?: string;
}

export interface ImageGenerationProvider {
  readonly id: string;
  readonly supportsMultiReference?: boolean;
  generate(request: ImageGenerationRequest): Promise<{ model: string; images: GeneratedImageSource[] }>;
}

export interface ImageUpscaleProvider {
  readonly id: string;
  upscale(request: ImageUpscaleRequest): Promise<{ model: string; image: GeneratedImageSource }>;
}

export interface OpenAIImageProviderOptions {
  id?: string;
  baseUrl?: string;
  apiKey: string;
  model?: string;
  quality?: "low" | "medium" | "high" | "auto";
  headers?: Record<string, string>;
}

const OPENAI_SIZES: Record<ImageAspectRatio, string> = {
  landscape: "1536x1024",
  square: "1024x1024",
  portrait: "1024x1536",
};

export class OpenAIImageProvider implements ImageGenerationProvider {
  readonly id: string;
  readonly supportsMultiReference = true;
  constructor(private readonly options: OpenAIImageProviderOptions) {
    this.id = options.id ?? "openai-images";
  }

  async generate(request: ImageGenerationRequest): Promise<{ model: string; images: GeneratedImageSource[] }> {
    const model = request.model ?? this.options.model ?? "gpt-image-1";
    const baseUrl = (this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    let response: Response;
    const references = request.sourceImages?.length ? request.sourceImages : request.sourceImage ? [request.sourceImage] : [];
    if (references.length) {
      const form = new FormData();
      for (const [index, reference] of references.entries()) {
        const sourceCopy = new Uint8Array(reference.bytes.byteLength);
        sourceCopy.set(reference.bytes);
        form.append(references.length === 1 ? "image" : "image[]", new Blob([sourceCopy.buffer], { type: reference.mimeType }), reference.fileName || `reference-${index + 1}.png`);
      }
      form.set("model", model);
      form.set("prompt", request.prompt);
      form.set("n", String(request.count));
      form.set("size", OPENAI_SIZES[request.aspectRatio]);
      form.set("quality", this.options.quality ?? "auto");
      form.set("response_format", "b64_json");
      response = await fetch(`${baseUrl}/images/edits`, {
        method: "POST", redirect: "manual",
        headers: { authorization: `Bearer ${this.options.apiKey}`, ...this.options.headers },
        body: form,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } else {
      response = await fetch(`${baseUrl}/images/generations`, {
        method: "POST", redirect: "manual",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          ...this.options.headers,
        },
        body: JSON.stringify({
          model,
          prompt: request.prompt,
          n: request.count,
          size: OPENAI_SIZES[request.aspectRatio],
          quality: this.options.quality ?? "auto",
          response_format: "b64_json",
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("OpenAI image provider redirects are forbidden.");
    if (!response.ok) throw await modelHttpError(this.id, response);
    const body = await boundedProviderJson(response) as { data?: Array<{ b64_json?: unknown; url?: unknown; revised_prompt?: unknown }> };
    if (!Array.isArray(body.data) || body.data.length === 0 || body.data.length > request.count) {
      throw new Error(`${this.id} returned an invalid image result count.`);
    }
    const images = body.data.map((item): GeneratedImageSource => ({
      ...(typeof item.b64_json === "string" ? { base64: item.b64_json } : {}),
      ...(typeof item.url === "string" ? { url: item.url } : {}),
      ...(typeof item.revised_prompt === "string" ? { revisedPrompt: item.revised_prompt } : {}),
    }));
    if (images.some((image) => !image.base64 && !image.url)) throw new Error(`${this.id} returned an image without data.`);
    return { model, images };
  }
}

export interface FalImageProviderOptions {
  id?: string;
  apiKey: string;
  model: string;
  editModel?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export class FalImageProvider implements ImageGenerationProvider {
  readonly id: string;
  readonly supportsMultiReference = true;
  private readonly model: string;
  private readonly editModel: string | undefined;
  constructor(private readonly options: FalImageProviderOptions) {
    this.id = options.id ?? "fal-images";
    this.model = safeFalModel(options.model);
    this.editModel = options.editModel ? safeFalModel(options.editModel) : undefined;
  }
  async generate(request: ImageGenerationRequest): Promise<{ model: string; images: GeneratedImageSource[] }> {
    const references = request.sourceImages?.length ? request.sourceImages : request.sourceImage ? [request.sourceImage] : [];
    const model = request.model ? safeFalModel(request.model) : references.length && this.editModel ? this.editModel : this.model;
    const base = (this.options.baseUrl ?? "https://fal.run").replace(/\/$/, "");
    const response = await fetch(`${base}/${model}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", authorization: `Key ${this.options.apiKey}`, ...this.options.headers },
      body: JSON.stringify({
        prompt: request.prompt,
        num_images: request.count,
        aspect_ratio: request.aspectRatio === "landscape" ? "16:9" : request.aspectRatio === "portrait" ? "9:16" : "1:1",
        ...(references.length ? { image_urls: references.map((item) => `data:${item.mimeType};base64,${Buffer.from(item.bytes).toString("base64")}`) } : {}),
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("FAL image provider redirects are forbidden.");
    if (!response.ok) throw await modelHttpError(this.id, response);
    const body = await boundedProviderJson(response);
    const values: any[] = Array.isArray(body.images) ? body.images : Array.isArray(body.data?.images) ? body.data.images : body.image ? [body.image] : [];
    const images = values.slice(0, request.count).map(normalizeFalImage).filter((item): item is GeneratedImageSource => Boolean(item));
    if (!images.length) throw new Error("FAL image provider returned no image data.");
    return { model, images };
  }
}

export interface FalImageUpscaleProviderOptions {
  id?: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export class FalImageUpscaleProvider implements ImageUpscaleProvider {
  readonly id: string;
  private readonly model: string;
  constructor(private readonly options: FalImageUpscaleProviderOptions) {
    this.id = options.id ?? "fal-upscale";
    this.model = safeFalModel(options.model);
  }
  async upscale(request: ImageUpscaleRequest): Promise<{ model: string; image: GeneratedImageSource }> {
    const base = (this.options.baseUrl ?? "https://fal.run").replace(/\/$/, "");
    const response = await fetch(`${base}/${this.model}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", authorization: `Key ${this.options.apiKey}`, ...this.options.headers },
      body: JSON.stringify({
        image_url: `data:${request.image.mimeType};base64,${Buffer.from(request.image.bytes).toString("base64")}`,
        scale: request.scale,
        upscale_factor: request.scale,
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("FAL upscaler redirects are forbidden.");
    if (!response.ok) throw await modelHttpError(this.id, response);
    const body = await boundedProviderJson(response);
    const image = normalizeFalImage(body.image ?? body.data?.image ?? body);
    if (!image) throw new Error("FAL upscaler returned no image data.");
    return { model: this.model, image };
  }
}

export interface ImageGenerationServiceOptions {
  maxImageBytes?: number;
  allowRemoteImageUrls?: boolean;
}

interface ImageFormat {
  extension: "png" | "jpg" | "webp" | "gif";
  mimeType: string;
}

function imageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: "jpg", mimeType: "image/jpeg" };
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { extension: "webp", mimeType: "image/webp" };
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)))) return { extension: "gif", mimeType: "image/gif" };
  return undefined;
}

function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const format = imageFormat(bytes);
  if (!format) return undefined;
  if (format.extension === "png" && bytes.length >= 24) return { width: Buffer.from(bytes).readUInt32BE(16), height: Buffer.from(bytes).readUInt32BE(20) };
  if (format.extension === "gif" && bytes.length >= 10) return { width: Buffer.from(bytes).readUInt16LE(6), height: Buffer.from(bytes).readUInt16LE(8) };
  if (format.extension === "webp" && bytes.length >= 30) {
    const chunk = Buffer.from(bytes.slice(12, 16)).toString("ascii");
    if (chunk === "VP8X") {
      const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
      return { width, height };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
      return { width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8), height: 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10) };
    }
    if (chunk === "VP8 " && bytes.length >= 30) return { width: Buffer.from(bytes).readUInt16LE(26) & 0x3fff, height: Buffer.from(bytes).readUInt16LE(28) & 0x3fff };
  }
  if (format.extension === "jpg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1]!;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        return { height: Buffer.from(bytes).readUInt16BE(offset + 5), width: Buffer.from(bytes).readUInt16BE(offset + 7) };
      }
      if (offset + 4 > bytes.length) break;
      const length = Buffer.from(bytes).readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return undefined;
}

function assertUpscaleDimensions(before: Uint8Array, after: Uint8Array, scale: 2 | 4): void {
  const source = imageDimensions(before), result = imageDimensions(after);
  if (!source || !result || source.width < 1 || source.height < 1 || result.width < source.width * scale || result.height < source.height * scale) {
    throw new Error(`Image upscaler did not return at least ${scale}x source dimensions.`);
  }
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  const normalized = value.replace(/^data:image\/[A-Za-z0-9.+-]+;base64,/, "").replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error("Image provider returned malformed base64 data.");
  if (normalized.length > Math.ceil(maxBytes * 4 / 3) + 8) throw new Error("Generated image exceeds the configured byte limit.");
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error("Generated image exceeds the configured byte limit.");
  return bytes;
}

async function fetchRemoteImage(rawUrl: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  let url = await assertSafeUrl(rawUrl);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 5; redirect++) {
    response = await fetch(url, { redirect: "manual", ...(signal ? { signal } : {}) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirect === 5) throw new Error("Generated image URL exceeded the redirect limit.");
    url = await assertSafeUrl(new URL(location, url).toString());
  }
  if (!response?.ok) throw new Error(`Generated image download failed with HTTP ${response?.status ?? 0}.`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType?.startsWith("image/") || contentType === "image/svg+xml") throw new Error("Generated image URL did not return a safe raster image.");
  const body = await readBoundedBody(response, maxBytes + 1);
  if (body.truncated || body.bytes.length > maxBytes) throw new Error("Generated image exceeds the configured byte limit.");
  return body.bytes;
}

function safeFalModel(value: string): string {
  const model = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/.test(model) || model.includes("..") || model.includes("//")) throw new Error("FAL image model ID is invalid.");
  return model;
}

function normalizeFalImage(value: any): GeneratedImageSource | undefined {
  if (typeof value === "string") return value.startsWith("http") ? { url: value } : { base64: value };
  if (!value || typeof value !== "object") return undefined;
  const url = typeof value.url === "string" ? value.url : typeof value.image_url === "string" ? value.image_url : undefined;
  const base64 = typeof value.base64 === "string" ? value.base64 : typeof value.b64_json === "string" ? value.b64_json : undefined;
  if (!url && !base64) return undefined;
  return { ...(url ? { url } : {}), ...(base64 ? { base64 } : {}) };
}

async function boundedProviderJson(response: Response): Promise<any> {
  const body = await readBoundedBody(response, 2 * 1024 * 1024 + 1);
  if (body.truncated || body.bytes.length > 2 * 1024 * 1024) throw new Error("Image provider response exceeds 2 MiB.");
  try { return JSON.parse(Buffer.from(body.bytes).toString("utf8")); }
  catch { throw new Error("Image provider returned invalid JSON."); }
}

export class ImageGenerationService {
  private readonly providers = new Map<string, ImageGenerationProvider>();
  private readonly upscalers = new Map<string, ImageUpscaleProvider>();
  private activeProviderId?: string;
  private readonly maxImageBytes: number;
  private readonly allowRemoteImageUrls: boolean;

  constructor(options: ImageGenerationServiceOptions = {}) {
    this.maxImageBytes = options.maxImageBytes ?? 20 * 1024 * 1024;
    this.allowRemoteImageUrls = options.allowRemoteImageUrls ?? false;
  }

  register(provider: ImageGenerationProvider, makeActive = false): void {
    if (this.providers.has(provider.id)) throw new Error(`Image provider ${provider.id} is already registered.`);
    this.providers.set(provider.id, provider);
    if (makeActive || !this.activeProviderId) this.activeProviderId = provider.id;
  }

  registerUpscaler(provider: ImageUpscaleProvider): void {
    if (this.upscalers.has(provider.id)) throw new Error(`Image upscaler ${provider.id} is already registered.`);
    this.upscalers.set(provider.id, provider);
  }

  list(): Array<{ id: string; active: boolean; multiReference: boolean }> {
    return [...this.providers.values()].map((provider) => ({ id: provider.id, active: provider.id === this.activeProviderId, multiReference: provider.supportsMultiReference === true }));
  }

  listUpscalers(): Array<{ id: string }> { return [...this.upscalers.keys()].sort().map((id) => ({ id })); }

  get configured(): boolean {
    return Boolean(this.activeProviderId);
  }
  get upscaleConfigured(): boolean { return this.upscalers.size > 0; }

  async generate(input: {
    workspacePath: string;
    prompt: string;
    aspectRatio?: ImageAspectRatio;
    count?: number;
    providerId?: string;
    model?: string;
    sourcePath?: string;
    sourcePaths?: string[];
    upscale?: { providerId: string; scale: 2 | 4 };
    signal?: AbortSignal;
  }): Promise<{
    provider: string; model: string; modality: "text" | "edit" | "multi-reference";
    pipeline: Array<{ provider: string; operation: "generate" | "edit" | "upscale"; model: string }>;
    images: Array<{ path: string; bytes: number; mimeType: string; revisedPrompt?: string }>;
  }> {
    const prompt = input.prompt.trim();
    if (!prompt || prompt.length > 20_000) throw new Error("Image prompt must contain 1 to 20,000 characters.");
    const count = Math.min(4, Math.max(1, Math.floor(input.count ?? 1)));
    const providerId = input.providerId ?? this.activeProviderId;
    const provider = providerId ? this.providers.get(providerId) : undefined;
    if (!provider) throw new Error(`Image generation provider ${providerId ?? "(default)"} is not configured.`);
    const root = await realpath(input.workspacePath);
    const requestedSources = [...(input.sourcePath ? [input.sourcePath] : []), ...(input.sourcePaths ?? [])];
    if (requestedSources.length > 8) throw new Error("Image generation accepts at most 8 reference images.");
    if (new Set(requestedSources).size !== requestedSources.length) throw new Error("Image reference paths must be unique.");
    const sourceImages: ImageInput[] = [];
    for (const requested of requestedSources) sourceImages.push(await this.loadWorkspaceImage(root, requested));
    if (sourceImages.reduce((sum, item) => sum + item.bytes.byteLength, 0) > 40 * 1024 * 1024) throw new Error("Image references exceed the 40 MiB aggregate limit.");
    if (sourceImages.length > 1 && provider.supportsMultiReference !== true) throw new Error(`Image provider ${provider.id} does not support multiple reference images.`);
    const result = await provider.generate({
      prompt,
      aspectRatio: input.aspectRatio ?? "landscape",
      count,
      ...(input.model ? { model: input.model } : {}),
      ...(sourceImages.length === 1 ? { sourceImage: sourceImages[0]!, sourceImages } : sourceImages.length ? { sourceImages } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const artifacts = resolve(root, ".haf", "artifacts", "images");
    const rel = relative(root, artifacts);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Image artifact directory escapes the workspace.");
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const pipeline: Array<{ provider: string; operation: "generate" | "edit" | "upscale"; model: string }> = [{
      provider: provider.id, operation: sourceImages.length ? "edit" : "generate", model: result.model,
    }];
    const images = [];
    for (const source of result.images) {
      let bytes = await this.resolveGeneratedSource(source, input.signal);
      let revisedPrompt = source.revisedPrompt;
      if (input.upscale) {
        const upscaler = this.upscalers.get(input.upscale.providerId);
        if (!upscaler) throw new Error(`Image upscaler ${input.upscale.providerId} is not configured.`);
        const currentFormat = imageFormat(bytes);
        if (!currentFormat) throw new Error("Generated artifact is not a supported raster image before upscaling.");
        const beforeUpscale = bytes;
        const upscaled = await upscaler.upscale({
          image: { bytes, mimeType: currentFormat.mimeType, fileName: `generated.${currentFormat.extension}` },
          scale: input.upscale.scale,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        bytes = await this.resolveGeneratedSource(upscaled.image, input.signal);
        assertUpscaleDimensions(beforeUpscale, bytes, input.upscale.scale);
        if (!pipeline.some((item) => item.operation === "upscale" && item.provider === upscaler.id)) {
          pipeline.push({ provider: upscaler.id, operation: "upscale", model: upscaled.model });
        }
      }
      const format = imageFormat(bytes);
      if (!format) throw new Error("Generated artifact is not a supported PNG, JPEG, WebP, or GIF image.");
      const name = `${Date.now()}-${randomUUID()}.${format.extension}`;
      const output = resolve(artifacts, name);
      await writeFile(output, bytes, { mode: 0o600, flag: "wx" });
      images.push({
        path: relative(root, output).split(sep).join("/"),
        bytes: bytes.length,
        mimeType: format.mimeType,
        ...(revisedPrompt ? { revisedPrompt } : {}),
      });
    }
    return {
      provider: provider.id,
      model: result.model,
      modality: sourceImages.length > 1 ? "multi-reference" : sourceImages.length ? "edit" : "text",
      pipeline,
      images,
    };
  }

  async upscale(input: {
    workspacePath: string;
    sourcePath: string;
    providerId: string;
    scale: 2 | 4;
    signal?: AbortSignal;
  }): Promise<{ provider: string; model: string; scale: 2 | 4; image: { path: string; bytes: number; mimeType: string } }> {
    const root = await realpath(input.workspacePath);
    const source = await this.loadWorkspaceImage(root, input.sourcePath);
    const provider = this.upscalers.get(input.providerId);
    if (!provider) throw new Error(`Image upscaler ${input.providerId} is not configured.`);
    const result = await provider.upscale({ image: source, scale: input.scale, ...(input.signal ? { signal: input.signal } : {}) });
    const bytes = await this.resolveGeneratedSource(result.image, input.signal);
    assertUpscaleDimensions(source.bytes, bytes, input.scale);
    const format = imageFormat(bytes);
    if (!format) throw new Error("Upscaled artifact is not a supported PNG, JPEG, WebP, or GIF image.");
    const artifacts = resolve(root, ".haf", "artifacts", "images");
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const output = resolve(artifacts, `${Date.now()}-${randomUUID()}-upscaled.${format.extension}`);
    await writeFile(output, bytes, { mode: 0o600, flag: "wx" });
    return { provider: provider.id, model: result.model, scale: input.scale, image: { path: relative(root, output).split(sep).join("/"), bytes: bytes.length, mimeType: format.mimeType } };
  }

  private async loadWorkspaceImage(root: string, requested: string): Promise<ImageInput> {
    const source = await realpath(resolve(root, requested));
    const sourceRelative = relative(root, source);
    if (sourceRelative === ".." || sourceRelative.startsWith(`..${sep}`) || sourceRelative.startsWith(sep)) throw new Error("Image reference escapes the workspace.");
    const bytes = await readFile(source);
    if (bytes.length === 0 || bytes.length > this.maxImageBytes) throw new Error("Image reference exceeds the configured byte limit.");
    const format = imageFormat(bytes);
    if (!format) throw new Error("Image reference is not a supported PNG, JPEG, WebP, or GIF image.");
    return { bytes, mimeType: format.mimeType, fileName: source.split(/[\\/]/).pop() ?? `source.${format.extension}` };
  }

  private async resolveGeneratedSource(source: GeneratedImageSource, signal?: AbortSignal): Promise<Uint8Array> {
    return source.base64
      ? decodeBase64(source.base64, this.maxImageBytes)
      : source.url && this.allowRemoteImageUrls
        ? await fetchRemoteImage(source.url, this.maxImageBytes, signal)
        : source.url
          ? (() => { throw new Error("Remote image URLs are disabled; configure a provider that returns base64 or explicitly opt in."); })()
          : (() => { throw new Error("Image provider returned no image data."); })();
  }
}
