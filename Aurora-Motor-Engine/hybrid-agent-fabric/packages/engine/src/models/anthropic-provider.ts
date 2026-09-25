import { randomUUID } from "node:crypto";
import type { AgentMessage, ModelProvider, ModelRequest, ModelStreamEvent, ToolCallContent } from "../types.js";
import { modelHttpError } from "./model-provider-error.js";
import { resolveWorkspaceImage } from "./multimodal.js";

export interface AnthropicProviderOptions {
  id?: string;
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  anthropicVersion?: string;
  headers?: Record<string, string>;
}

async function messageBlocks(message: AgentMessage, workspacePath?: string): Promise<any[]> {
  const blocks: any[] = [];
  for (const part of message.content) {
    if (part.type === "text") blocks.push({ type: "text", text: part.text });
    else if (part.type === "image") {
      const image = await resolveWorkspaceImage(part, workspacePath);
      blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.base64 } });
    } else if (part.type === "tool_call") {
      blocks.push({ type: "tool_use", id: part.id, name: part.name.replaceAll(".", "__"), input: part.arguments });
    } else if (part.type === "tool_result") {
      blocks.push({ type: "tool_result", tool_use_id: part.toolCallId, content: JSON.stringify(part.result), is_error: part.isError });
    }
  }
  return blocks;
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  constructor(private readonly options: AnthropicProviderOptions) {
    this.id = options.id ?? "anthropic";
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const messages: any[] = [];
    for (const message of request.messages) {
      if (message.role === "system") continue;
      const role = message.role === "assistant" ? "assistant" : "user";
      const blocks = await messageBlocks(message, request.workspacePath);
      const previous = messages.at(-1);
      if (previous?.role === role) previous.content.push(...blocks);
      else messages.push({ role, content: blocks });
    }
    // Explicit prompt-cache breakpoints (Hermes-style plan): one at the end of
    // the system block, one on the last tool, and one on each of the last N
    // non-system messages. Markers ride only on text blocks; an assistant
    // turn that is pure tool calls gets no marker rather than a malformed one.
    const cache = request.promptCache;
    const payload: Record<string, unknown> = {
      model: request.model?.includes(":") ? request.model.slice(request.model.indexOf(":") + 1) : this.options.model,
      max_tokens: this.options.maxTokens ?? 8192,
      messages,
      tools: request.tools.map((tool) => ({
        name: tool.id.replaceAll(".", "__"),
        description: `${tool.description} [capability-id: ${tool.id}]`,
        input_schema: tool.inputSchema,
      })),
    };
    if (cache && cache.ttlMs > 0) {
      if (cache.systemBreakpoint) {
        payload.system = [{ type: "text", text: request.systemPrompt, cache_control: { type: "ephemeral", ttl: `${Math.round(cache.ttlMs / 60_000)}m` } }];
      } else {
        payload.system = request.systemPrompt;
      }
      if (cache.toolBreakpoint && Array.isArray(payload.tools) && (payload.tools as unknown[]).length > 0) {
        const tools = payload.tools as any[];
        tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral", ttl: `${Math.round(cache.ttlMs / 60_000)}m` } };
      }
      if (cache.messageTailMarkers > 0) {
        const tailStart = Math.max(0, messages.length - cache.messageTailMarkers);
        for (let index = tailStart; index < messages.length; index++) {
          const message = messages[index] as any;
          const blocks = message?.content;
          if (!Array.isArray(blocks)) continue;
          const textIndex = blocks.map((block: any) => block.type).lastIndexOf("text");
          if (textIndex < 0) continue;
          blocks[textIndex] = { ...blocks[textIndex], cache_control: { type: "ephemeral", ttl: `${Math.round(cache.ttlMs / 60_000)}m` } };
        }
      }
    }
    const response = await fetch(`${(this.options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.options.apiKey,
        "anthropic-version": this.options.anthropicVersion ?? "2023-06-01",
        ...this.options.headers,
      },
      body: JSON.stringify(payload),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!response.ok) throw await modelHttpError(this.id, response);
    const body: any = await response.json();
    let toolUse = false;
    for (const block of body.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") yield { type: "text_delta", delta: block.text };
      if (block.type === "tool_use") {
        toolUse = true;
        const call: ToolCallContent = {
          type: "tool_call",
          id: block.id ?? randomUUID(),
          name: String(block.name ?? "unknown").replaceAll("__", "."),
          arguments: block.input && typeof block.input === "object" ? block.input : {},
        };
        yield { type: "tool_call", call };
      }
    }
    const usage = body.usage ?? {};
    yield {
      type: "usage",
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
    };
    yield { type: "done", stopReason: toolUse || body.stop_reason === "tool_use" ? "tool_use" : body.stop_reason === "max_tokens" ? "max_tokens" : "end_turn" };
  }
}
