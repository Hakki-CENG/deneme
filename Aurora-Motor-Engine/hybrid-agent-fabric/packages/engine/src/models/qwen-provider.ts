/**
 * Qwen Provider — Aurora Cognitive Runtime
 *
 * Qwen3.8-27B için özel provider.
 * OpenAI-compatible provider'ı extends eder.
 * Qwen-specific features: reasoning, tool calling, vision.
 */

import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from "./openai-compatible-provider.js";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../types.js";

export interface QwenProviderOptions {
  id?: string;
  baseUrl: string;
  apiKey?: string | undefined;
  model?: string;
  headers?: Record<string, string> | undefined;
  /** Qwen model variant */
  variant?: "qwen3" | "qwen3.5" | "qwen3.8-27b";
  /** Enable reasoning mode */
  enableReasoning?: boolean;
  /** Enable tool calling */
  enableToolCalling?: boolean;
  /** Enable vision */
  enableVision?: boolean;
  /** Custom system prompt for reasoning */
  reasoningSystemPrompt?: string;
}

export class QwenProvider implements ModelProvider {
  readonly id: string;
  private baseProvider: OpenAICompatibleProvider;
  private options: QwenProviderOptions;

  constructor(options: QwenProviderOptions) {
    this.options = {
      variant: "qwen3.8-27b",
      enableReasoning: true,
      enableToolCalling: true,
      enableVision: false,
      ...options,
    };
    this.id = options.id ?? `qwen-${this.options.variant}`;
    this.baseProvider = new OpenAICompatibleProvider({
      id: this.id,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model ?? this.getDefaultModel(),
      headers: options.headers,
    });
  }

  private getDefaultModel(): string {
    switch (this.options.variant) {
      case "qwen3": return "qwen3";
      case "qwen3.5": return "qwen3.5";
      case "qwen3.8-27b": return "qwen3.8-27b";
      default: return "qwen3";
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    // Qwen-specific preprocessing
    const enhancedRequest = this.enhanceRequest(request);
    
    // Delegate to base provider
    yield* this.baseProvider.stream(enhancedRequest);
  }

  private enhanceRequest(request: ModelRequest): ModelRequest {
    const enhanced = { ...request };

    // Add reasoning system prompt if enabled
    if (this.options.enableReasoning && !enhanced.systemPrompt) {
      enhanced.systemPrompt = this.getReasoningSystemPrompt();
    }

    // Enhance tools with Qwen-specific format
    if (this.options.enableToolCalling && enhanced.tools) {
      enhanced.tools = enhanced.tools.map(tool => ({
        ...tool,
        description: `${tool.description} [Qwen optimized]`,
      }));
    }

    return enhanced;
  }

  private getReasoningSystemPrompt(): string {
    return this.options.reasoningSystemPrompt ?? 
      `You are Qwen, a helpful AI assistant developed by Alibaba Cloud. 
You are designed to be helpful, harmless, and honest.
You have access to tools and can reason step by step.
When solving problems, think step by step and show your reasoning.
Use tools when necessary to gather information or perform actions.`;
  }

  /** Get provider capabilities */
  getCapabilities(): {
    reasoning: boolean;
    toolCalling: boolean;
    vision: boolean;
    maxContextWindow: number;
    maxOutputTokens: number;
  } {
    return {
      reasoning: this.options.enableReasoning ?? true,
      toolCalling: this.options.enableToolCalling ?? true,
      vision: this.options.enableVision ?? false,
      maxContextWindow: 131072, // 128K context for Qwen3.8-27B
      maxOutputTokens: 8192,
    };
  }

  /** Get model info */
  getModelInfo(): {
    id: string;
    variant: string;
    provider: string;
    baseUrl: string;
  } {
    return {
      id: this.id,
      variant: this.options.variant ?? "qwen3.8-27b",
      provider: "qwen",
      baseUrl: this.options.baseUrl,
    };
  }
}

/**
 * Qwen Provider Factory
 * 
 * Qwen provider'ı kolayca oluşturmak için factory fonksiyonu.
 */
export function createQwenProvider(options: {
  baseUrl: string;
  apiKey?: string;
  variant?: "qwen3" | "qwen3.5" | "qwen3.8-27b";
  enableReasoning?: boolean;
  enableToolCalling?: boolean;
  enableVision?: boolean;
}): QwenProvider {
  return new QwenProvider({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    variant: options.variant ?? "qwen3.8-27b",
    enableReasoning: options.enableReasoning ?? true,
    enableToolCalling: options.enableToolCalling ?? true,
    enableVision: options.enableVision ?? false,
  });
}

/**
 * Local Qwen Provider
 * 
 * Ollama üzerinden local Qwen çalıştırır.
 */
export function createLocalQwenProvider(options?: {
  port?: number | undefined;
  variant?: "qwen3" | "qwen3.5" | "qwen3.8-27b" | undefined;
  enableReasoning?: boolean;
  enableToolCalling?: boolean;
}): QwenProvider {
  const port = options?.port ?? 11434;
  return new QwenProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    variant: options?.variant ?? "qwen3",
    enableReasoning: options?.enableReasoning ?? true,
    enableToolCalling: options?.enableToolCalling ?? true,
    enableVision: false,
  });
}
