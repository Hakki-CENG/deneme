import { randomUUID } from "node:crypto";
import type { AgentMessage, ModelProvider, ModelRequest, ModelStreamEvent, ToolCallContent } from "../types.js";
import { modelHttpError } from "./model-provider-error.js";
import { resolveWorkspaceImage } from "./multimodal.js";

export interface GeminiProviderOptions {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  accessToken?: string;
  model: string;
  maxOutputTokens?: number;
  temperature?: number;
  headers?: Record<string, string>;
}

function bareModel(model: string): string {
  const selected = model.includes(":") ? model.slice(model.indexOf(":") + 1) : model;
  return selected.replace(/^models\//, "");
}

function functionName(name: string): string {
  return name.replaceAll(".", "__");
}

function hafName(name: string): string {
  return name.replaceAll("__", ".");
}

async function messageParts(message: AgentMessage, includeToolCallIds: boolean, workspacePath?: string): Promise<any[]> {
  const parts: any[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text) parts.push({ text: part.text });
    } else if (part.type === "image") {
      const image = await resolveWorkspaceImage(part, workspacePath);
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } });
    } else if (part.type === "tool_call") {
      parts.push({
        functionCall: {
          ...(includeToolCallIds ? { id: part.id } : {}),
          name: functionName(part.name),
          args: part.arguments,
        },
      });
    } else if (part.type === "tool_result") {
      parts.push({
        functionResponse: {
          ...(includeToolCallIds ? { id: part.toolCallId } : {}),
          name: functionName(part.name),
          response: part.result && typeof part.result === "object" && !Array.isArray(part.result)
            ? { ...part.result, ...(part.isError ? { _haf_error: true } : {}) }
            : { result: part.result, ...(part.isError ? { _haf_error: true } : {}) },
        },
      });
    }
  }
  return parts;
}

function geminiMajor(model: string): number | undefined {
  const match = /^gemini-(\d+)/i.exec(bareModel(model));
  return match ? Number(match[1]) : undefined;
}

async function toContents(messages: AgentMessage[], includeToolCallIds: boolean, workspacePath?: string): Promise<any[]> {
  const contents: any[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const parts = await messageParts(message, includeToolCallIds, workspacePath);
    if (parts.length === 0) continue;
    const previous = contents.at(-1);
    // Native Gemini accepts grouped function responses and consecutive same-role
    // turns more reliably when they are merged into one content block.
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

export class GeminiProvider implements ModelProvider {
  readonly id: string;

  constructor(private readonly options: GeminiProviderOptions) {
    if (!options.apiKey && !options.accessToken) throw new Error("Gemini provider requires an API key or OAuth access token.");
    if (options.apiKey && options.accessToken) throw new Error("Gemini provider cannot combine API-key and OAuth-token authentication.");
    this.id = options.id ?? "google";
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const model = bareModel(request.model ?? this.options.model);
    const includeToolCallIds = (geminiMajor(model) ?? 0) >= 3;
    const baseUrl = (this.options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "").replace(/\/openai$/, "");
    const response = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { "x-goog-api-key": this.options.apiKey } : {}),
        ...(this.options.accessToken ? { authorization: `Bearer ${this.options.accessToken}` } : {}),
        ...this.options.headers,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.systemPrompt }] },
        contents: await toContents(request.messages, includeToolCallIds, request.workspacePath),
        ...(request.tools.length > 0
          ? {
              tools: [{
                functionDeclarations: request.tools.map((tool) => ({
                  name: functionName(tool.id),
                  description: `${tool.description} [capability-id: ${tool.id}]`,
                  parameters: tool.inputSchema,
                })),
              }],
            }
          : {}),
        generationConfig: {
          maxOutputTokens: this.options.maxOutputTokens ?? 8192,
          ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
        },
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!response.ok) throw await modelHttpError(this.id, response);

    const body: any = await response.json();
    const candidate = body.candidates?.[0] ?? {};
    let toolUse = false;
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text) {
        yield part.thought === true
          ? { type: "reasoning_delta", delta: part.text }
          : { type: "text_delta", delta: part.text };
      }
      if (part.functionCall && typeof part.functionCall.name === "string") {
        toolUse = true;
        const call: ToolCallContent = {
          type: "tool_call",
          id: typeof part.functionCall.id === "string" ? part.functionCall.id : randomUUID(),
          name: hafName(part.functionCall.name),
          arguments: part.functionCall.args && typeof part.functionCall.args === "object" && !Array.isArray(part.functionCall.args)
            ? part.functionCall.args
            : {},
        };
        yield { type: "tool_call", call };
      }
    }
    const usage = body.usageMetadata ?? {};
    yield {
      type: "usage",
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        cacheReadTokens: usage.cachedContentTokenCount ?? 0,
        cacheWriteTokens: 0,
      },
    };
    const finishReason = String(candidate.finishReason ?? "STOP").toUpperCase();
    yield {
      type: "done",
      stopReason: toolUse ? "tool_use" : finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
    };
  }
}
