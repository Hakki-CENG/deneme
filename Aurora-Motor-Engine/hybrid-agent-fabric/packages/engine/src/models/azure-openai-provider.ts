import { randomUUID } from "node:crypto";
import type { AgentMessage, ModelProvider, ModelRequest, ModelStreamEvent, ToolCallContent } from "../types.js";
import { modelHttpError } from "./model-provider-error.js";
import { resolveWorkspaceImage } from "./multimodal.js";

export interface AzureOpenAIProviderOptions {
  id?: string;
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion?: string;
  headers?: Record<string, string>;
}

function text(message: AgentMessage): string {
  return message.content.map((part) => part.type === "text" ? part.text : part.type === "tool_result" ? JSON.stringify(part.result) : "").filter(Boolean).join("\n");
}

async function userContent(message: AgentMessage, workspacePath?: string): Promise<string | any[]> {
  const imageParts = message.content.filter((part) => part.type === "image");
  if (!imageParts.length) return text(message);
  const content: any[] = [];
  const value = text(message);
  if (value) content.push({ type: "text", text: value });
  for (const part of imageParts) {
    if (part.type !== "image") continue;
    const image = await resolveWorkspaceImage(part, workspacePath);
    content.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}` } });
  }
  return content;
}

function endpoint(options: AzureOpenAIProviderOptions): URL {
  const base = new URL(options.endpoint);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Azure OpenAI endpoint must be credential-free HTTPS without query or fragment.");
  const deployment = options.deployment.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deployment)) throw new Error("Azure OpenAI deployment name is invalid.");
  const root = base.toString().replace(/\/$/, "").replace(/\/openai(?:\/v1)?$/, "");
  const url = new URL(`${root}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`);
  url.searchParams.set("api-version", options.apiVersion ?? "2024-10-21");
  return url;
}

export class AzureOpenAIProvider implements ModelProvider {
  readonly id: string;
  constructor(private readonly options: AzureOpenAIProviderOptions) {
    this.id = options.id ?? "azure-openai";
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const messages: any[] = [{ role: "system", content: request.systemPrompt }];
    for (const message of request.messages) {
      if (message.role === "system") continue;
      if (message.role === "tool") {
        const result = message.content.find((part) => part.type === "tool_result");
        if (result?.type === "tool_result") messages.push({ role: "tool", tool_call_id: result.toolCallId, content: JSON.stringify(result.result) });
      } else if (message.role === "assistant") {
        const calls = message.content.filter((part) => part.type === "tool_call");
        messages.push({
          role: "assistant",
          content: text(message) || null,
          ...(calls.length ? { tool_calls: calls.map((call) => call.type === "tool_call" ? {
            id: call.id,
            type: "function",
            function: { name: call.name.replaceAll(".", "__"), arguments: JSON.stringify(call.arguments) },
          } : undefined).filter(Boolean) } : {}),
        });
      } else messages.push({ role: "user", content: await userContent(message, request.workspacePath) });
    }
    const response = await fetch(endpoint(this.options), {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": this.options.apiKey, ...this.options.headers },
      body: JSON.stringify({
        messages,
        stream: false,
        tools: request.tools.map((tool) => ({
          type: "function",
          function: { name: tool.id.replaceAll(".", "__"), description: `${tool.description} [capability-id: ${tool.id}]`, parameters: tool.inputSchema },
        })),
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!response.ok) throw await modelHttpError(this.id, response);
    const body: any = await response.json();
    const choice = body.choices?.[0] ?? {};
    const output = choice.message ?? {};
    if (typeof output.content === "string" && output.content) yield { type: "text_delta", delta: output.content };
    let toolUse = false;
    for (const item of output.tool_calls ?? []) {
      toolUse = true;
      let args: Record<string, any> = {};
      try {
        const parsed = JSON.parse(item.function?.arguments ?? "{}");
        args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
      } catch { args = { raw: String(item.function?.arguments ?? "") }; }
      const call: ToolCallContent = {
        type: "tool_call",
        id: item.id ?? randomUUID(),
        name: String(item.function?.name ?? "unknown").replaceAll("__", "."),
        arguments: args,
      };
      yield { type: "tool_call", call };
    }
    const usage = body.usage ?? {};
    yield { type: "usage", usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
    } };
    yield { type: "done", stopReason: toolUse ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn" };
  }
}
