import { randomUUID } from "node:crypto";
import type { AgentMessage, ModelProvider, ModelRequest, ModelStreamEvent, ToolCallContent } from "../types.js";
import { modelHttpError } from "./model-provider-error.js";
import { resolveWorkspaceImage } from "./multimodal.js";

export interface OpenAIResponsesProviderOptions {
  id?: string;
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
  headers?: Record<string, string>;
}

function selectedModel(request: ModelRequest, fallback: string): string {
  return request.model?.includes(":") ? request.model.slice(request.model.indexOf(":") + 1) : fallback;
}

export async function openAIResponsesInputItems(messages: AgentMessage[], workspacePath?: string): Promise<any[]> {
  const input: any[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n");
      const content: any[] = text ? [{ type: "input_text", text }] : [];
      for (const part of message.content) {
        if (part.type !== "image") continue;
        const image = await resolveWorkspaceImage(part, workspacePath);
        content.push({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.base64}` });
      }
      if (content.length) input.push({ role: "user", content });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n");
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const part of message.content) {
        if (part.type === "tool_call") {
          input.push({
            type: "function_call",
            call_id: part.id,
            name: part.name.replaceAll(".", "__"),
            arguments: JSON.stringify(part.arguments),
          });
        }
      }
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool_result") {
        input.push({
          type: "function_call_output",
          call_id: part.toolCallId,
          output: JSON.stringify(part.result),
        });
      }
    }
  }
  return input;
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly id: string;
  constructor(private readonly options: OpenAIResponsesProviderOptions) {
    this.id = options.id ?? "openai-responses";
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const response = await fetch(`${(this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
        ...this.options.headers,
      },
      body: JSON.stringify({
        model: selectedModel(request, this.options.model),
        instructions: request.systemPrompt,
        input: await openAIResponsesInputItems(request.messages, request.workspacePath),
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.id.replaceAll(".", "__"),
          description: `${tool.description} [capability-id: ${tool.id}]`,
          parameters: tool.inputSchema,
          strict: false,
        })),
        max_output_tokens: this.options.maxOutputTokens ?? 8192,
        store: false,
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!response.ok) throw await modelHttpError(this.id, response);
    const body: any = await response.json();
    let toolUse = false;
    for (const item of body.output ?? []) {
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && typeof part.text === "string" && part.text) yield { type: "text_delta", delta: part.text };
          if (part.type === "refusal" && typeof part.refusal === "string" && part.refusal) yield { type: "text_delta", delta: part.refusal };
        }
      }
      if (item.type === "function_call" && typeof item.name === "string") {
        toolUse = true;
        let argumentsValue: Record<string, any> = {};
        try {
          const parsed = JSON.parse(typeof item.arguments === "string" ? item.arguments : "{}");
          argumentsValue = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
        } catch {
          argumentsValue = { raw: String(item.arguments ?? "") };
        }
        const call: ToolCallContent = {
          type: "tool_call",
          id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : randomUUID(),
          name: item.name.replaceAll("__", "."),
          arguments: argumentsValue,
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
        cacheReadTokens: usage.input_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
    };
    const incompleteReason = body.incomplete_details?.reason;
    yield {
      type: "done",
      stopReason: toolUse ? "tool_use" : incompleteReason === "max_output_tokens" ? "max_tokens" : "end_turn",
    };
  }
}
