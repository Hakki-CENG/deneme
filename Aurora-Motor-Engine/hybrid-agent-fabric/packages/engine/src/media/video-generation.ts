import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { assertSafeUrl, readBoundedBody } from "../capabilities/web.js";
import { atomicWriteBuffer } from "../util/atomic-file.js";
import { resolveWorkspaceImage } from "../models/multimodal.js";
import type { ImageContent } from "../types.js";

export type VideoAspectRatio = "landscape" | "square" | "portrait";

export interface VideoGenerationRequest {
  prompt: string;
  aspectRatio: VideoAspectRatio;
  durationSeconds?: number;
  sourceImage?: { base64: string; mimeType: ImageContent["mimeType"] };
  sourceImages?: Array<{ base64: string; mimeType: ImageContent["mimeType"] }>;
  signal?: AbortSignal;
}

export interface GeneratedVideoSource {
  base64?: string;
  url?: string;
  mimeType?: string;
}

export interface VideoInput {
  bytes: Uint8Array;
  mimeType: "video/mp4" | "video/webm";
  fileName: string;
}
export interface VideoUpscaleRequest {
  video: VideoInput;
  scale: 2 | 4;
  signal?: AbortSignal;
}
export interface VideoUpscaleProvider {
  readonly id: string;
  upscale(request: VideoUpscaleRequest): Promise<{ model: string; video: GeneratedVideoSource }>;
}

export interface VideoGenerationProvider {
  readonly id: string;
  readonly supportsMultiReference?: boolean;
  generate(request: VideoGenerationRequest): Promise<{ model: string; video: GeneratedVideoSource }>;
}

export interface QueuedVideoGenerationProvider {
  readonly id: string;
  readonly supportsMultiReference?: boolean;
  submit(request: VideoGenerationRequest): Promise<{ externalJobId: string; model: string }>;
  poll(externalJobId: string, signal?: AbortSignal): Promise<
    | { status: "queued" | "running" }
    | { status: "succeeded"; model: string; video: GeneratedVideoSource }
    | { status: "failed"; code: string }
  >;
  cancel(externalJobId: string, signal?: AbortSignal): Promise<void>;
}

export interface FalVideoProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

function safeModel(value: string): string {
  const model = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/.test(model) || model.includes("..") || model.includes("//")) throw new Error("FAL video model ID is invalid.");
  return model;
}

export class FalVideoProvider implements VideoGenerationProvider {
  readonly id = "fal";
  readonly supportsMultiReference = true;
  private readonly model: string;
  constructor(private readonly options: FalVideoProviderOptions) {
    this.model = safeModel(options.model);
  }

  async generate(request: VideoGenerationRequest): Promise<{ model: string; video: GeneratedVideoSource }> {
    const base = (this.options.baseUrl ?? "https://fal.run").replace(/\/$/, "");
    const references = request.sourceImages?.length ? request.sourceImages : request.sourceImage ? [request.sourceImage] : [];
    const response = await fetch(`${base}/${this.model}`, {
      method: "POST", redirect: "manual",
      headers: {
        "content-type": "application/json",
        authorization: `Key ${this.options.apiKey}`,
        ...this.options.headers,
      },
      body: JSON.stringify({
        prompt: request.prompt,
        aspect_ratio: request.aspectRatio === "landscape" ? "16:9" : request.aspectRatio === "portrait" ? "9:16" : "1:1",
        ...(request.durationSeconds ? { duration: request.durationSeconds } : {}),
        ...(references.length === 1 ? { image_url: `data:${references[0]!.mimeType};base64,${references[0]!.base64}` } : {}),
        ...(references.length > 1 ? { image_urls: references.map((item) => `data:${item.mimeType};base64,${item.base64}`) } : {}),
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("FAL video provider redirects are forbidden.");
    if (!response.ok) throw new Error(`FAL video API returned HTTP ${response.status}.`);
    const encoded = await readBoundedBody(response, 2 * 1024 * 1024 + 1);
    if (encoded.truncated || encoded.bytes.length > 2 * 1024 * 1024) throw new Error("FAL video response exceeds 2 MiB.");
    let body: any;
    try { body = JSON.parse(Buffer.from(encoded.bytes).toString("utf8")); }
    catch { throw new Error("FAL video provider returned invalid JSON."); }
    const candidate = body?.video ?? body?.data?.video ?? body;
    const url = typeof candidate?.url === "string" ? candidate.url : typeof body?.video_url === "string" ? body.video_url : undefined;
    const base64 = typeof candidate?.base64 === "string" ? candidate.base64 : typeof body?.video_base64 === "string" ? body.video_base64 : undefined;
    if (!url && !base64) throw new Error("FAL video provider returned no video data.");
    return {
      model: this.model,
      video: {
        ...(url ? { url } : {}),
        ...(base64 ? { base64 } : {}),
        ...(typeof candidate?.content_type === "string" ? { mimeType: candidate.content_type } : {}),
      },
    };
  }
}

export interface FalQueuedVideoProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export class FalQueuedVideoProvider implements QueuedVideoGenerationProvider {
  readonly id = "fal-queue";
  readonly supportsMultiReference = true;
  private readonly model: string;
  private readonly baseUrl: string;
  constructor(private readonly options: FalQueuedVideoProviderOptions) {
    this.model = safeModel(options.model);
    const base = new URL(options.baseUrl ?? "https://queue.fal.run");
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("FAL queue base URL must be credential-free HTTPS.");
    this.baseUrl = base.toString().replace(/\/$/, "");
  }
  async submit(request: VideoGenerationRequest): Promise<{ externalJobId: string; model: string }> {
    const response = await this.request(`${this.baseUrl}/${this.model}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Key ${this.options.apiKey}`, ...this.options.headers },
      body: JSON.stringify(falVideoBody(request)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const body = await parseBoundedJson(response, "FAL queue submission");
    const externalJobId = safeExternalJobId(body.request_id);
    return { externalJobId, model: this.model };
  }
  async poll(externalJobId: string, signal?: AbortSignal): Promise<
    | { status: "queued" | "running" }
    | { status: "succeeded"; model: string; video: GeneratedVideoSource }
    | { status: "failed"; code: string }
  > {
    const id = safeExternalJobId(externalJobId);
    const root = `${this.baseUrl}/${this.model}/requests/${encodeURIComponent(id)}`;
    const statusResponse = await this.request(`${root}/status`, {
      method: "GET", headers: { authorization: `Key ${this.options.apiKey}`, ...this.options.headers }, ...(signal ? { signal } : {}),
    });
    const statusBody = await parseBoundedJson(statusResponse, "FAL queue status");
    const status = String(statusBody.status ?? "").toUpperCase();
    if (["IN_QUEUE", "QUEUED"].includes(status)) return { status: "queued" };
    if (["IN_PROGRESS", "RUNNING"].includes(status)) return { status: "running" };
    if (["FAILED", "ERROR", "CANCELLED"].includes(status)) return { status: "failed", code: status.toLowerCase() };
    if (!["COMPLETED", "SUCCEEDED"].includes(status)) throw new Error("FAL queue returned an unknown job status.");
    const resultResponse = await this.request(root, {
      method: "GET", headers: { authorization: `Key ${this.options.apiKey}`, ...this.options.headers }, ...(signal ? { signal } : {}),
    });
    const body = await parseBoundedJson(resultResponse, "FAL queue result");
    const candidate = body?.video ?? body?.data?.video ?? body;
    const url = typeof candidate?.url === "string" ? candidate.url : typeof body?.video_url === "string" ? body.video_url : undefined;
    const base64 = typeof candidate?.base64 === "string" ? candidate.base64 : typeof body?.video_base64 === "string" ? body.video_base64 : undefined;
    if (!url && !base64) throw new Error("FAL queue result returned no video data.");
    return { status: "succeeded", model: this.model, video: { ...(url ? { url } : {}), ...(base64 ? { base64 } : {}), ...(typeof candidate?.content_type === "string" ? { mimeType: candidate.content_type } : {}) } };
  }
  async cancel(externalJobId: string, signal?: AbortSignal): Promise<void> {
    const id = safeExternalJobId(externalJobId);
    await this.request(`${this.baseUrl}/${this.model}/requests/${encodeURIComponent(id)}/cancel`, {
      method: "PUT", headers: { authorization: `Key ${this.options.apiKey}`, ...this.options.headers }, ...(signal ? { signal } : {}),
    });
  }
  private async request(url: string, init: RequestInit): Promise<Response> {
    const target = new URL(url);
    if (target.origin !== new URL(this.baseUrl).origin) throw new Error("FAL queue request escaped its configured origin.");
    const response = await fetch(target, { ...init, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("FAL queue redirects are forbidden.");
    }
    if (!response.ok) throw new Error(`FAL queue API returned HTTP ${response.status}.`);
    return response;
  }
}

export interface FalVideoUpscaleProviderOptions {
  id?: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export class FalVideoUpscaleProvider implements VideoUpscaleProvider {
  readonly id: string;
  private readonly model: string;
  private readonly baseUrl: string;
  constructor(private readonly options: FalVideoUpscaleProviderOptions) {
    this.id = options.id ?? "fal-video-upscale";
    this.model = safeModel(options.model);
    const base = new URL(options.baseUrl ?? "https://fal.run");
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("FAL video upscaler base URL must be credential-free HTTPS.");
    this.baseUrl = base.toString().replace(/\/$/, "");
  }
  async upscale(request: VideoUpscaleRequest): Promise<{ model: string; video: GeneratedVideoSource }> {
    const response = await fetch(`${this.baseUrl}/${this.model}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", authorization: `Key ${this.options.apiKey}`, ...this.options.headers },
      body: JSON.stringify({
        video_url: `data:${request.video.mimeType};base64,${Buffer.from(request.video.bytes).toString("base64")}`,
        scale: request.scale,
        upscale_factor: request.scale,
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("FAL video upscaler redirects are forbidden.");
    if (!response.ok) throw new Error(`FAL video upscaler returned HTTP ${response.status}.`);
    const body = await parseBoundedJson(response, "FAL video upscaler");
    const candidate = body?.video ?? body?.data?.video ?? body;
    const url = typeof candidate?.url === "string" ? candidate.url : typeof body?.video_url === "string" ? body.video_url : undefined;
    const base64 = typeof candidate?.base64 === "string" ? candidate.base64 : typeof body?.video_base64 === "string" ? body.video_base64 : undefined;
    if (!url && !base64) throw new Error("FAL video upscaler returned no video data.");
    return { model: this.model, video: { ...(url ? { url } : {}), ...(base64 ? { base64 } : {}), ...(typeof candidate?.content_type === "string" ? { mimeType: candidate.content_type } : {}) } };
  }
}

export interface VideoGenerationServiceOptions {
  maxVideoBytes?: number;
  allowRemoteVideoUrls?: boolean;
}

function videoFormat(bytes: Uint8Array): { extension: "mp4" | "webm"; mimeType: "video/mp4" | "video/webm" } | undefined {
  if (bytes.length >= 12 && Buffer.from(bytes.slice(4, 8)).toString("ascii") === "ftyp") return { extension: "mp4", mimeType: "video/mp4" };
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { extension: "webm", mimeType: "video/webm" };
  return undefined;
}

function videoDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const format = videoFormat(bytes);
  if (format?.extension === "mp4") return mp4Dimensions(bytes, 0, bytes.length, 0);
  if (format?.extension === "webm") {
    const width = findEbmlUnsigned(bytes, 0xb0), height = findEbmlUnsigned(bytes, 0xba);
    return width && height ? { width, height } : undefined;
  }
  return undefined;
}

function mp4Dimensions(bytes: Uint8Array, start: number, end: number, depth: number): { width: number; height: number } | undefined {
  if (depth > 8) return undefined;
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);
  let offset = start;
  while (offset + 8 <= end) {
    let size = Buffer.from(bytes).readUInt32BE(offset);
    const type = Buffer.from(bytes.slice(offset + 4, offset + 8)).toString("ascii");
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return undefined;
      const large = Buffer.from(bytes).readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      size = Number(large); header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return undefined;
    if (type === "tkhd" && size >= header + 20) {
      const widthFixed = Buffer.from(bytes).readUInt32BE(offset + size - 8);
      const heightFixed = Buffer.from(bytes).readUInt32BE(offset + size - 4);
      const width = Math.floor(widthFixed / 65536), height = Math.floor(heightFixed / 65536);
      if (width > 0 && height > 0) return { width, height };
    }
    if (containers.has(type)) {
      const found = mp4Dimensions(bytes, offset + header, offset + size, depth + 1);
      if (found) return found;
    }
    offset += size;
  }
  return undefined;
}

function findEbmlUnsigned(bytes: Uint8Array, elementId: number): number | undefined {
  const limit = Math.min(bytes.length, 4 * 1024 * 1024);
  for (let index = 4; index + 2 < limit; index++) {
    if (bytes[index] !== elementId) continue;
    const first = bytes[index + 1]!;
    let length = 1, mask = 0x80;
    while (length <= 8 && !(first & mask)) { length++; mask >>= 1; }
    if (length > 4 || index + 1 + length >= limit) continue;
    let size = first & (mask - 1);
    for (let offset = 1; offset < length; offset++) size = size * 256 + bytes[index + 1 + offset]!;
    if (size < 1 || size > 4 || index + 1 + length + size > limit) continue;
    let value = 0;
    for (let offset = 0; offset < size; offset++) value = value * 256 + bytes[index + 1 + length + offset]!;
    if (value > 0 && value <= 16384) return value;
  }
  return undefined;
}

function assertVideoUpscaleDimensions(before: Uint8Array, after: Uint8Array, scale: 2 | 4): void {
  const source = videoDimensions(before), result = videoDimensions(after);
  if (!source || !result || result.width < source.width * scale || result.height < source.height * scale) {
    throw new Error(`Video upscaler did not return at least ${scale}x source dimensions.`);
  }
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  const normalized = value.replace(/^data:video\/[A-Za-z0-9.+-]+;base64,/, "").replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) throw new Error("Video provider returned malformed base64 data.");
  if (normalized.length > Math.ceil(maxBytes * 4 / 3) + 8) throw new Error("Generated video exceeds the configured byte limit.");
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.length || bytes.length > maxBytes) throw new Error("Generated video exceeds the configured byte limit.");
  return bytes;
}

async function fetchRemoteVideo(rawUrl: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  let url = await assertSafeUrl(rawUrl);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 5; redirect++) {
    response = await fetch(url, { redirect: "manual", ...(signal ? { signal } : {}) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirect === 5) throw new Error("Generated video URL exceeded the redirect limit.");
    url = await assertSafeUrl(new URL(location, url).toString());
  }
  if (!response?.ok) throw new Error(`Generated video download failed with HTTP ${response?.status ?? 0}.`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "video/mp4" && contentType !== "video/webm" && contentType !== "application/octet-stream") throw new Error("Generated video URL returned an unsupported content type.");
  const body = await readBoundedBody(response, maxBytes + 1);
  if (body.truncated || body.bytes.length > maxBytes) throw new Error("Generated video exceeds the configured byte limit.");
  return body.bytes;
}

export class VideoGenerationService {
  private readonly providers = new Map<string, VideoGenerationProvider>();
  private readonly queuedProviders = new Map<string, QueuedVideoGenerationProvider>();
  private readonly upscalers = new Map<string, VideoUpscaleProvider>();
  private activeProviderId?: string;
  private readonly maxVideoBytes: number;
  private readonly allowRemoteVideoUrls: boolean;

  constructor(options: VideoGenerationServiceOptions = {}) {
    this.maxVideoBytes = options.maxVideoBytes ?? 100 * 1024 * 1024;
    this.allowRemoteVideoUrls = options.allowRemoteVideoUrls ?? false;
  }

  register(provider: VideoGenerationProvider, active = false): void {
    if (this.providers.has(provider.id)) throw new Error(`Video provider ${provider.id} is already registered.`);
    this.providers.set(provider.id, provider);
    if (active || !this.activeProviderId) this.activeProviderId = provider.id;
  }

  registerQueued(provider: QueuedVideoGenerationProvider): void {
    if (this.queuedProviders.has(provider.id)) throw new Error(`Queued video provider ${provider.id} is already registered.`);
    this.queuedProviders.set(provider.id, provider);
  }
  registerUpscaler(provider: VideoUpscaleProvider): void {
    if (this.upscalers.has(provider.id)) throw new Error(`Video upscaler ${provider.id} is already registered.`);
    this.upscalers.set(provider.id, provider);
  }

  get configured(): boolean { return Boolean(this.activeProviderId); }
  get queueConfigured(): boolean { return this.queuedProviders.size > 0; }
  get upscaleConfigured(): boolean { return this.upscalers.size > 0; }
  list(): Array<{ id: string; active: boolean }> { return [...this.providers.keys()].map((id) => ({ id, active: id === this.activeProviderId })); }
  listQueued(): Array<{ id: string; multiReference: boolean }> { return [...this.queuedProviders.values()].map((provider) => ({ id: provider.id, multiReference: provider.supportsMultiReference === true })); }
  listUpscalers(): Array<{ id: string }> { return [...this.upscalers.keys()].sort().map((id) => ({ id })); }

  async generate(input: {
    workspacePath: string;
    prompt: string;
    aspectRatio?: VideoAspectRatio;
    durationSeconds?: number;
    sourcePath?: string;
    sourcePaths?: string[];
    providerId?: string;
    signal?: AbortSignal;
  }): Promise<{ provider: string; model: string; modality: "text" | "image" | "multi-reference"; references: number; video: { path: string; bytes: number; mimeType: string } }> {
    const prompt = input.prompt.trim();
    if (!prompt || prompt.length > 20_000) throw new Error("Video prompt must contain 1 to 20,000 characters.");
    const durationSeconds = input.durationSeconds === undefined ? undefined : Math.min(30, Math.max(1, Math.floor(input.durationSeconds)));
    const providerId = input.providerId ?? this.activeProviderId;
    const provider = providerId ? this.providers.get(providerId) : undefined;
    if (!provider) throw new Error(`Video generation provider ${providerId ?? "(default)"} is not configured.`);
    const root = await realpath(input.workspacePath);
    const requestedSources = [...(input.sourcePath ? [input.sourcePath] : []), ...(input.sourcePaths ?? [])];
    if (requestedSources.length > 4) throw new Error("Video generation accepts at most 4 reference images.");
    if (new Set(requestedSources).size !== requestedSources.length) throw new Error("Video reference paths must be unique.");
    const sourceImages: NonNullable<VideoGenerationRequest["sourceImages"]> = [];
    let referenceBytes = 0;
    for (const path of requestedSources) {
      const image = await resolveWorkspaceImage({ type: "image", path, mimeType: mimeFromPath(path) }, root);
      referenceBytes += image.bytes.byteLength;
      sourceImages.push({ base64: image.base64, mimeType: image.mimeType });
    }
    if (referenceBytes > 40 * 1024 * 1024) throw new Error("Video references exceed the 40 MiB aggregate limit.");
    if (sourceImages.length > 1 && provider.supportsMultiReference !== true) throw new Error(`Video provider ${provider.id} does not support multiple reference images.`);
    const result = await provider.generate({
      prompt,
      aspectRatio: input.aspectRatio ?? "landscape",
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(sourceImages.length === 1 ? { sourceImage: sourceImages[0]!, sourceImages } : sourceImages.length ? { sourceImages } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const bytes = result.video.base64
      ? decodeBase64(result.video.base64, this.maxVideoBytes)
      : result.video.url && this.allowRemoteVideoUrls
        ? await fetchRemoteVideo(result.video.url, this.maxVideoBytes, input.signal)
        : result.video.url
          ? (() => { throw new Error("Remote video URLs are disabled; explicitly enable bounded materialization."); })()
          : (() => { throw new Error("Video provider returned no video data."); })();
    const format = videoFormat(bytes);
    if (!format) throw new Error("Generated artifact is not a supported MP4 or WebM video.");
    const directory = resolve(root, ".haf", "artifacts", "videos");
    const rel = relative(root, directory);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Video artifact directory escapes the workspace.");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const output = resolve(directory, `${Date.now()}-${randomUUID()}.${format.extension}`);
    await atomicWriteBuffer(output, bytes);
    return {
      provider: provider.id,
      model: result.model,
      modality: sourceImages.length > 1 ? "multi-reference" : sourceImages.length ? "image" : "text",
      references: sourceImages.length,
      video: { path: relative(root, output).split(sep).join("/"), bytes: bytes.length, mimeType: format.mimeType },
    };
  }

  async upscale(input: { workspacePath: string; sourcePath: string; providerId: string; scale: 2 | 4; signal?: AbortSignal }): Promise<{ provider: string; model: string; scale: 2 | 4; video: { path: string; bytes: number; mimeType: string; width: number; height: number } }> {
    const provider = this.upscalers.get(input.providerId);
    if (!provider) throw new Error(`Video upscaler ${input.providerId} is not configured.`);
    const root = await realpath(input.workspacePath);
    const source = await this.loadWorkspaceVideo(root, input.sourcePath);
    const before = videoDimensions(source.bytes);
    if (!before) throw new Error("Video source dimensions could not be verified.");
    const result = await provider.upscale({ video: source, scale: input.scale, ...(input.signal ? { signal: input.signal } : {}) });
    const bytes = result.video.base64
      ? decodeBase64(result.video.base64, this.maxVideoBytes)
      : result.video.url && this.allowRemoteVideoUrls
        ? await fetchRemoteVideo(result.video.url, this.maxVideoBytes, input.signal)
        : result.video.url
          ? (() => { throw new Error("Remote video URLs are disabled; explicitly enable bounded materialization."); })()
          : (() => { throw new Error("Video upscaler returned no video data."); })();
    assertVideoUpscaleDimensions(source.bytes, bytes, input.scale);
    const dimensions = videoDimensions(bytes)!;
    const format = videoFormat(bytes);
    if (!format) throw new Error("Upscaled artifact is not a supported MP4 or WebM video.");
    const directory = resolve(root, ".haf", "artifacts", "videos");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const output = resolve(directory, `${Date.now()}-${randomUUID()}-upscaled.${format.extension}`);
    await atomicWriteBuffer(output, bytes);
    return { provider: provider.id, model: result.model, scale: input.scale, video: { path: relative(root, output).split(sep).join("/"), bytes: bytes.length, mimeType: format.mimeType, ...dimensions } };
  }

  async submitQueued(input: {
    workspacePath: string; prompt: string; aspectRatio?: VideoAspectRatio; durationSeconds?: number;
    sourcePath?: string; sourcePaths?: string[]; providerId: string; signal?: AbortSignal;
  }): Promise<{ provider: string; externalJobId: string; model: string; modality: "text" | "image" | "multi-reference"; references: number }> {
    const provider = this.queuedProviders.get(input.providerId);
    if (!provider) throw new Error(`Queued video provider ${input.providerId} is not configured.`);
    const prompt = input.prompt.trim();
    if (!prompt || prompt.length > 20_000) throw new Error("Video prompt must contain 1 to 20,000 characters.");
    const root = await realpath(input.workspacePath);
    const requested = [...(input.sourcePath ? [input.sourcePath] : []), ...(input.sourcePaths ?? [])];
    if (requested.length > 4 || new Set(requested).size !== requested.length) throw new Error("Queued video references must be unique and limited to 4.");
    const sourceImages: NonNullable<VideoGenerationRequest["sourceImages"]> = [];
    let referenceBytes = 0;
    for (const path of requested) {
      const image = await resolveWorkspaceImage({ type: "image", path, mimeType: mimeFromPath(path) }, root);
      referenceBytes += image.bytes.byteLength;
      sourceImages.push({ base64: image.base64, mimeType: image.mimeType });
    }
    if (referenceBytes > 40 * 1024 * 1024) throw new Error("Video references exceed the 40 MiB aggregate limit.");
    if (sourceImages.length > 1 && provider.supportsMultiReference !== true) throw new Error(`Queued video provider ${provider.id} does not support multiple references.`);
    const durationSeconds = input.durationSeconds === undefined ? undefined : Math.min(30, Math.max(1, Math.floor(input.durationSeconds)));
    const result = await provider.submit({
      prompt, aspectRatio: input.aspectRatio ?? "landscape",
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(sourceImages.length === 1 ? { sourceImage: sourceImages[0]!, sourceImages } : sourceImages.length ? { sourceImages } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { provider: provider.id, externalJobId: result.externalJobId, model: result.model, modality: sourceImages.length > 1 ? "multi-reference" : sourceImages.length ? "image" : "text", references: sourceImages.length };
  }

  async pollQueued(input: { workspacePath: string; providerId: string; externalJobId: string; signal?: AbortSignal }): Promise<
    | { status: "queued" | "running" }
    | { status: "failed"; code: string }
    | { status: "succeeded"; model: string; video: { path: string; bytes: number; mimeType: string } }
  > {
    const provider = this.queuedProviders.get(input.providerId);
    if (!provider) throw new Error(`Queued video provider ${input.providerId} is not configured.`);
    const result = await provider.poll(input.externalJobId, input.signal);
    if (result.status !== "succeeded") return result;
    const root = await realpath(input.workspacePath);
    const video = await this.materialize(root, result.video, input.signal);
    return { status: "succeeded", model: result.model, video };
  }

  async cancelQueued(input: { providerId: string; externalJobId: string; signal?: AbortSignal }): Promise<void> {
    const provider = this.queuedProviders.get(input.providerId);
    if (!provider) throw new Error(`Queued video provider ${input.providerId} is not configured.`);
    await provider.cancel(input.externalJobId, input.signal);
  }

  private async loadWorkspaceVideo(root: string, requested: string): Promise<VideoInput> {
    const path = await realpath(resolve(root, requested));
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Video source escapes the workspace.");
    const bytes = await readFile(path);
    if (!bytes.length || bytes.length > this.maxVideoBytes) throw new Error("Video source exceeds the configured byte limit.");
    const format = videoFormat(bytes);
    if (!format) throw new Error("Video source is not a supported MP4 or WebM file.");
    return { bytes, mimeType: format.mimeType, fileName: path.split(/[\\/]/).pop() ?? `source.${format.extension}` };
  }

  private async materialize(root: string, source: GeneratedVideoSource, signal?: AbortSignal): Promise<{ path: string; bytes: number; mimeType: string }> {
    const bytes = source.base64
      ? decodeBase64(source.base64, this.maxVideoBytes)
      : source.url && this.allowRemoteVideoUrls
        ? await fetchRemoteVideo(source.url, this.maxVideoBytes, signal)
        : source.url
          ? (() => { throw new Error("Remote video URLs are disabled; explicitly enable bounded materialization."); })()
          : (() => { throw new Error("Video provider returned no video data."); })();
    const format = videoFormat(bytes);
    if (!format) throw new Error("Generated artifact is not a supported MP4 or WebM video.");
    const directory = resolve(root, ".haf", "artifacts", "videos");
    const rel = relative(root, directory);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Video artifact directory escapes the workspace.");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const output = resolve(directory, `${Date.now()}-${randomUUID()}.${format.extension}`);
    await atomicWriteBuffer(output, bytes);
    return { path: relative(root, output).split(sep).join("/"), bytes: bytes.length, mimeType: format.mimeType };
  }
}

function falVideoBody(request: VideoGenerationRequest): Record<string, unknown> {
  const references = request.sourceImages?.length ? request.sourceImages : request.sourceImage ? [request.sourceImage] : [];
  return {
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio === "landscape" ? "16:9" : request.aspectRatio === "portrait" ? "9:16" : "1:1",
    ...(request.durationSeconds ? { duration: request.durationSeconds } : {}),
    ...(references.length === 1 ? { image_url: `data:${references[0]!.mimeType};base64,${references[0]!.base64}` } : {}),
    ...(references.length > 1 ? { image_urls: references.map((item) => `data:${item.mimeType};base64,${item.base64}`) } : {}),
  };
}

async function parseBoundedJson(response: Response, label: string): Promise<any> {
  const body = await readBoundedBody(response, 2 * 1024 * 1024 + 1);
  if (body.truncated || body.bytes.length > 2 * 1024 * 1024) throw new Error(`${label} response exceeds 2 MiB.`);
  try { return body.bytes.length ? JSON.parse(Buffer.from(body.bytes).toString("utf8")) : {}; }
  catch { throw new Error(`${label} returned invalid JSON.`); }
}

function safeExternalJobId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error("FAL queue returned an invalid request id.");
  return value;
}

function mimeFromPath(path: string): ImageContent["mimeType"] {
  const extension = path.toLowerCase().split(".").pop();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  throw new Error("Video source image extension must be PNG, JPEG, WebP, or GIF.");
}
