import { randomUUID } from "node:crypto";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ContentBlock,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import type { AgentMessage, JsonValue, ModelProvider, ModelRequest, ModelStreamEvent, ToolCallContent } from "../types.js";
import { ModelProviderError } from "./model-provider-error.js";
import { resolveWorkspaceImage } from "./multimodal.js";

export interface BedrockConverseClient {
  send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
}

export interface BedrockProviderOptions {
  id?: string;
  region: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  client?: BedrockConverseClient;
}

function modelId(request: ModelRequest, fallback: string): string {
  return request.model?.includes(":") ? request.model.slice(request.model.indexOf(":") + 1) : fallback;
}

async function toContent(message: AgentMessage, workspacePath?: string): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text) content.push({ text: part.text });
    else if (part.type === "image") {
      const image = await resolveWorkspaceImage(part, workspacePath);
      const format = image.mimeType === "image/png" ? "png" : image.mimeType === "image/jpeg" ? "jpeg" : image.mimeType === "image/gif" ? "gif" : "webp";
      content.push({ image: { format, source: { bytes: image.bytes } } });
    } else if (part.type === "tool_call") content.push({
      toolUse: {
        toolUseId: part.id,
        name: part.name.replaceAll(".", "__"),
        input: part.arguments as any,
      },
    });
    else if (part.type === "tool_result") content.push({
      toolResult: {
        toolUseId: part.toolCallId,
        content: [{ json: part.result as any }],
        status: part.isError ? "error" : "success",
      },
    });
  }
  return content;
}

async function messages(input: AgentMessage[], workspacePath?: string): Promise<Message[]> {
  const output: Message[] = [];
  for (const message of input) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" as const : "user" as const;
    const content = await toContent(message, workspacePath);
    if (!content.length) continue;
    const previous = output.at(-1);
    if (previous?.role === role) previous.content?.push(...content);
    else output.push({ role, content });
  }
  return output;
}

function classifyBedrockError(id: string, error: unknown): ModelProviderError {
  const name = error instanceof Error ? error.name : "BedrockError";
  const retryable = ["ThrottlingException", "ServiceUnavailableException", "ModelTimeoutException", "InternalServerException"].includes(name);
  return new ModelProviderError(`AWS Bedrock ${name}: ${error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)}`, {
    providerId: id,
    code: name,
    retryable,
    credentialDisposition: name === "UnrecognizedClientException" || name === "AccessDeniedException" ? "disable" : retryable ? "cooldown" : "none",
    cause: error,
  });
}

export class BedrockProvider implements ModelProvider {
  readonly id: string;
  private readonly client: BedrockConverseClient;

  constructor(private readonly options: BedrockProviderOptions) {
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(options.region)) throw new Error("AWS Bedrock region is invalid.");
    this.id = options.id ?? "aws-bedrock";
    this.client = options.client ?? new BedrockRuntimeClient({ region: options.region });
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const input: ConverseCommandInput = {
      modelId: modelId(request, this.options.model),
      system: [{ text: request.systemPrompt }],
      messages: await messages(request.messages, request.workspacePath),
      toolConfig: request.tools.length ? {
        tools: request.tools.map((tool) => ({
          toolSpec: {
            name: tool.id.replaceAll(".", "__"),
            description: `${tool.description} [capability-id: ${tool.id}]`,
            inputSchema: { json: tool.inputSchema as any },
          },
        })),
      } : undefined,
      inferenceConfig: {
        maxTokens: this.options.maxTokens ?? 8192,
        ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
      },
    };
    let response: ConverseCommandOutput;
    try {
      response = await this.client.send(new ConverseCommand(input), request.signal ? { abortSignal: request.signal } : undefined);
    } catch (error) {
      throw classifyBedrockError(this.id, error);
    }
    let toolUse = false;
    for (const part of response.output?.message?.content ?? []) {
      if (typeof part.text === "string" && part.text) yield { type: "text_delta", delta: part.text };
      if (part.toolUse?.name) {
        toolUse = true;
        const call: ToolCallContent = {
          type: "tool_call",
          id: part.toolUse.toolUseId ?? randomUUID(),
          name: part.toolUse.name.replaceAll("__", "."),
          arguments: part.toolUse.input && typeof part.toolUse.input === "object" && !Array.isArray(part.toolUse.input)
            ? part.toolUse.input as Record<string, JsonValue>
            : {},
        };
        yield { type: "tool_call", call };
      }
    }
    const usage: any = response.usage ?? {};
    yield { type: "usage", usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadInputTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteInputTokens ?? 0,
    } };
    yield {
      type: "done",
      stopReason: toolUse || response.stopReason === "tool_use" ? "tool_use" : response.stopReason === "max_tokens" ? "max_tokens" : "end_turn",
    };
  }
}
