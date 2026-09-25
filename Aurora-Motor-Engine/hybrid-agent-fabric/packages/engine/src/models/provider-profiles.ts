import type { ModelProvider } from "../types.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { CredentialPoolModelProvider, type CredentialPoolStateStore, type ProviderCredentialInput } from "./provider-credential-pool.js";
import { OpenAIResponsesProvider } from "./openai-responses-provider.js";
import { AzureOpenAIProvider } from "./azure-openai-provider.js";
import { BedrockProvider } from "./bedrock-provider.js";

export type ProviderApiMode = "openai-chat-completions" | "openai-responses" | "azure-openai-chat" | "bedrock-converse" | "anthropic-messages" | "gemini-generate-content" | "vertex-gemini";

export interface ProviderProfile {
  id: string;
  displayName: string;
  apiMode: ProviderApiMode;
  defaultBaseUrl?: string;
  apiKeyEnvironmentVariable: string;
  defaultModel?: string;
  aliases?: string[];
  dataPolicy?: "provider" | "aggregator" | "local";
  credentialMode?: "api-key" | "aws-default";
}

export interface ProviderRuntimeConfig {
  profileId: string;
  runtimeId?: string;
  apiKey?: string;
  /** Multiple same-provider credentials. Values stay inside provider closures. */
  apiKeys?: ProviderCredentialInput[];
  baseUrl?: string;
  model?: string;
  headers?: Record<string, string>;
  apiVersion?: string;
  region?: string;
}

const BUILTIN_PROFILES: ProviderProfile[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    apiMode: "openai-chat-completions",
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyEnvironmentVariable: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1-mini",
    dataPolicy: "provider",
  },
  {
    id: "openai-responses",
    displayName: "OpenAI Responses API",
    apiMode: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyEnvironmentVariable: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1-mini",
    aliases: ["responses"],
    dataPolicy: "provider",
  },
  {
    id: "azure-openai",
    displayName: "Azure OpenAI (native deployment API)",
    apiMode: "azure-openai-chat",
    apiKeyEnvironmentVariable: "AZURE_OPENAI_API_KEY",
    dataPolicy: "provider",
  },
  {
    id: "aws-bedrock",
    displayName: "AWS Bedrock Converse (native)",
    apiMode: "bedrock-converse",
    apiKeyEnvironmentVariable: "AWS_ACCESS_KEY_ID",
    credentialMode: "aws-default",
    dataPolicy: "provider",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    apiMode: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    apiKeyEnvironmentVariable: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-5-20250929",
    dataPolicy: "provider",
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    apiMode: "openai-chat-completions",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnvironmentVariable: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4.5",
    dataPolicy: "aggregator",
  },
  {
    id: "google",
    displayName: "Google Gemini (native GenerateContent)",
    apiMode: "gemini-generate-content",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnvironmentVariable: "GEMINI_API_KEY",
    defaultModel: "gemini-pro-latest",
    aliases: ["gemini"],
    dataPolicy: "provider",
  },
  {
    id: "vertex",
    displayName: "Google Vertex AI Gemini (native)",
    apiMode: "vertex-gemini",
    apiKeyEnvironmentVariable: "GOOGLE_VERTEX_ACCESS_TOKEN",
    defaultModel: "gemini-pro-latest",
    dataPolicy: "provider",
  },
  {
    id: "groq",
    displayName: "Groq",
    apiMode: "openai-chat-completions",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvironmentVariable: "GROQ_API_KEY",
    dataPolicy: "provider",
  },
  {
    id: "xai",
    displayName: "xAI",
    apiMode: "openai-chat-completions",
    defaultBaseUrl: "https://api.x.ai/v1",
    apiKeyEnvironmentVariable: "XAI_API_KEY",
    dataPolicy: "provider",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    apiMode: "openai-chat-completions",
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyEnvironmentVariable: "DEEPSEEK_API_KEY",
    dataPolicy: "provider",
  },
  {
    id: "mistral",
    displayName: "Mistral",
    apiMode: "openai-chat-completions",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    apiKeyEnvironmentVariable: "MISTRAL_API_KEY",
    dataPolicy: "provider",
  },
  {
    id: "ollama",
    displayName: "Ollama",
    apiMode: "openai-chat-completions",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnvironmentVariable: "OLLAMA_API_KEY",
    defaultModel: "qwen3",
    dataPolicy: "local",
  },
  {
    id: "qwen",
    displayName: "Qwen (Alibaba Cloud)",
    apiMode: "openai-chat-completions",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnvironmentVariable: "QWEN_API_KEY",
    defaultModel: "qwen3.8-27b",
    aliases: ["qwen3", "qwen3.8", "qwen-27b"],
    dataPolicy: "provider",
  },
  {
    id: "qwen-local",
    displayName: "Qwen Local (Ollama)",
    apiMode: "openai-chat-completions",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnvironmentVariable: "OLLAMA_API_KEY",
    defaultModel: "qwen3.8-27b",
    aliases: ["qwen-local", "local-qwen"],
    dataPolicy: "local",
  },
];

export class ProviderProfileRegistry {
  private readonly profiles = new Map<string, ProviderProfile>();
  private readonly aliases = new Map<string, string>();

  constructor(includeBuiltins = true, private readonly credentialPoolStateStore?: CredentialPoolStateStore) {
    if (includeBuiltins) for (const profile of BUILTIN_PROFILES) this.register(profile);
  }

  register(profile: ProviderProfile): void {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.id)) throw new Error(`Invalid provider profile id: ${profile.id}`);
    if (this.profiles.has(profile.id)) throw new Error(`Provider profile ${profile.id} already exists.`);
    this.profiles.set(profile.id, structuredClone(profile));
    for (const alias of profile.aliases ?? []) this.aliases.set(alias, profile.id);
  }

  get(idOrAlias: string): ProviderProfile | undefined {
    const profile = this.profiles.get(this.aliases.get(idOrAlias) ?? idOrAlias);
    return profile ? structuredClone(profile) : undefined;
  }

  list(): ProviderProfile[] {
    return [...this.profiles.values()].map((profile) => structuredClone(profile));
  }

  createProvider(config: ProviderRuntimeConfig): { provider: ModelProvider; modelName: string; profile: ProviderProfile } {
    const profile = this.get(config.profileId);
    if (!profile) throw new Error(`Unknown provider profile: ${config.profileId}`);
    const environmentKey = process.env[profile.apiKeyEnvironmentVariable]?.trim();
    if (profile.credentialMode === "aws-default" && (config.apiKey || config.apiKeys?.length)) {
      throw new Error("AWS Bedrock uses the AWS default credential chain and does not accept API-key pools.");
    }
    const configuredCredentials: ProviderCredentialInput[] = profile.credentialMode === "aws-default" ? [] : [
      ...(config.apiKey?.trim() ? [{ id: "primary", apiKey: config.apiKey.trim() }] : []),
      ...(config.apiKeys ?? []),
      ...(!config.apiKey && !(config.apiKeys?.length) && environmentKey ? [{ id: "environment", apiKey: environmentKey }] : []),
    ];
    if (configuredCredentials.length === 0 && profile.dataPolicy !== "local" && profile.credentialMode !== "aws-default") {
      throw new Error(`Missing ${profile.apiKeyEnvironmentVariable} for provider ${profile.id}.`);
    }
    const modelName = config.model ?? profile.defaultModel;
    if (!modelName) throw new Error(`No model configured for provider ${profile.id}.`);
    const baseUrl = config.baseUrl ?? profile.defaultBaseUrl;
    if (!baseUrl && profile.apiMode !== "bedrock-converse") throw new Error(`Provider ${profile.id} requires an explicit base URL.`);
    const runtimeId = config.runtimeId ?? profile.id;
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(runtimeId)) throw new Error(`Invalid model runtime id: ${runtimeId}`);
    const build = (apiKey: string): ModelProvider => {
      if (profile.apiMode === "bedrock-converse") {
        return new BedrockProvider({
          id: runtimeId,
          region: config.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
          model: modelName,
        });
      }
      if (profile.apiMode === "azure-openai-chat") {
        return new AzureOpenAIProvider({
          id: runtimeId,
          endpoint: baseUrl!,
          apiKey,
          deployment: modelName,
          ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
          ...(config.headers ? { headers: config.headers } : {}),
        });
      }
      if (profile.apiMode === "anthropic-messages") {
        return new AnthropicProvider({
          id: runtimeId,
          baseUrl: baseUrl!,
          apiKey,
          model: modelName,
          ...(config.headers ? { headers: config.headers } : {}),
        });
      }
      if (profile.apiMode === "openai-responses") {
        return new OpenAIResponsesProvider({
          id: runtimeId,
          baseUrl: baseUrl!,
          apiKey,
          model: modelName,
          ...(config.headers ? { headers: config.headers } : {}),
        });
      }
      if (profile.apiMode === "vertex-gemini") {
        return new GeminiProvider({
          id: runtimeId,
          baseUrl: baseUrl!,
          accessToken: apiKey,
          model: modelName,
          ...(config.headers ? { headers: config.headers } : {}),
        });
      }
      if (profile.apiMode === "gemini-generate-content") {
        return new GeminiProvider({
          id: runtimeId,
          baseUrl: baseUrl!,
          apiKey,
          model: modelName,
          ...(config.headers ? { headers: config.headers } : {}),
        });
      }
      return new OpenAICompatibleProvider({
        id: runtimeId,
        baseUrl: baseUrl!,
        ...(apiKey ? { apiKey } : {}),
        model: modelName,
        ...(config.headers ? { headers: config.headers } : {}),
      });
    };
    const provider = configuredCredentials.length > 1
      ? new CredentialPoolModelProvider(runtimeId, configuredCredentials, build, { ...(this.credentialPoolStateStore ? { stateStore: this.credentialPoolStateStore } : {}) })
      : build(configuredCredentials[0]?.apiKey ?? "");
    return { provider, modelName: `${runtimeId}:${modelName}`, profile };
  }
}
