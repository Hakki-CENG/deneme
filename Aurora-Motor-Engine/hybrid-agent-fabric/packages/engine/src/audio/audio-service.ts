import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export interface AudioServiceOptions {
  baseUrl?: string;
  apiKey: string;
  transcriptionModel?: string;
  speechModel?: string;
  defaultVoice?: string;
  maxInputBytes?: number;
}

async function confinedExisting(workspace: string, requested: string): Promise<string> {
  const root = await realpath(workspace);
  const target = await realpath(resolve(root, requested));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Audio input escapes the workspace.");
  return target;
}

function confinedOutput(workspace: string, requested: string): string {
  const root = resolve(workspace);
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Audio output escapes the workspace.");
  return target;
}

function mimeFor(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  return ({ mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", webm: "audio/webm", flac: "audio/flac" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

export class AudioService {
  constructor(private readonly options: AudioServiceOptions) {}

  async transcribe(input: {
    workspacePath: string;
    path: string;
    language?: string;
    prompt?: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; model: string; durationMs: number }> {
    const startedAt = Date.now();
    const path = await confinedExisting(input.workspacePath, input.path);
    const data = await readFile(path);
    if (data.length > (this.options.maxInputBytes ?? 25 * 1024 * 1024)) throw new Error("Audio input exceeds the configured byte limit.");
    const form = new FormData();
    form.set("file", new Blob([data], { type: mimeFor(path) }), path.split(/[\\/]/).pop() ?? "audio");
    const model = this.options.transcriptionModel ?? "whisper-1";
    form.set("model", model);
    if (input.language) form.set("language", input.language);
    if (input.prompt) form.set("prompt", input.prompt);
    const response = await fetch(`${(this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: form,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) throw new Error(`Transcription API ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    const body = await response.json() as { text?: unknown };
    if (typeof body.text !== "string") throw new Error("Transcription provider returned no text.");
    return { text: body.text, model, durationMs: Date.now() - startedAt };
  }

  async synthesize(input: {
    workspacePath: string;
    text: string;
    outputPath: string;
    voice?: string;
    format?: "mp3" | "wav" | "opus" | "aac" | "flac";
    speed?: number;
    signal?: AbortSignal;
  }): Promise<{ path: string; bytes: number; model: string; voice: string; durationMs: number }> {
    const startedAt = Date.now();
    if (!input.text.trim() || input.text.length > 100_000) throw new Error("Speech text must contain 1-100000 characters.");
    const output = confinedOutput(input.workspacePath, input.outputPath);
    await mkdir(dirname(output), { recursive: true });
    const model = this.options.speechModel ?? "gpt-4o-mini-tts";
    const voice = input.voice ?? this.options.defaultVoice ?? "alloy";
    const response = await fetch(`${(this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        voice,
        input: input.text,
        response_format: input.format ?? "mp3",
        speed: input.speed ?? 1,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) throw new Error(`Speech API ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    const data = Buffer.from(await response.arrayBuffer());
    await writeFile(output, data, { mode: 0o600 });
    return { path: input.outputPath, bytes: data.length, model, voice, durationMs: Date.now() - startedAt };
  }
}
