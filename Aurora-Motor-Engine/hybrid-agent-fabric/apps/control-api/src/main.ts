import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import rawBody from "fastify-raw-body";
import formbody from "@fastify/formbody";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { reviewVerdict, searchCapabilities, ENGINE_VERSION } from "@haf/engine";
import { dashboardHtml } from "./dashboard.js";
import { registerCognitiveRoutes, registerMetaControllerRoutes, registerAuroraServiceRoutes } from "./routes/index.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { IdentityService, type Identity } from "./auth/identity-service.js";
import { registerAuthGuards } from "./auth/auth-guards.js";
import { allowlisted, PlatformJwtVerifier, verifyDiscordSignature, verifyFeishuSignature, verifyLineSignature, verifySharedSecret, verifySlackSignature, verifyWhatsAppSignature } from "./platforms/verification.js";
import { registerRateLimiting, registerSecurityHeaders, registerErrorHandler, registerAuditLogger } from "./middleware/index.js";
import { AppError } from "./middleware/error-handler.js";
import { registerMaintenance } from "./middleware/maintenance.js";
import { registerAuroraServiceErrorTyping } from "./routes/aurora-service-errors.js";
import {
  HybridAgentEngine,
  commandEnvelopeSchema,
  type EngineConfig,
  type AutomationTrigger,
  WorkerProcessManager,
  FleetMonitor,
  type WorkerProtocolClient,
  TelegramAdapter,
  DiscordBotAdapter,
  SlackAdapter,
  SignedWebhookAdapter,
  WhatsAppCloudAdapter,
  MatrixAdapter,
  SignalRestAdapter,
  MattermostAdapter,
  LineMessagingAdapter,
  GoogleChatAdapter,
  MicrosoftTeamsAdapter,
  FeishuAdapter,
  IrcChannelAdapter,
  EmailChannelAdapter,
  TwilioSmsAdapter,
  type CommandEnvelope,
  type InputSource,
  type JsonValue,
  type Schedule,
  type SessionSnapshot,
  transcriptAsJson,
  transcriptAsMarkdown,
  transcriptAsTrajectory,
  BrokerBackedMcpOAuthProvider,
  McpOAuthPendingNotFoundError,
  GitHubAppPendingNotFoundError,
  GitHubAppWebhookVerificationError,
  ModelOAuthPendingNotFoundError,
  ModelOAuthError,
} from "@haf/engine";

const defaultHomePath = fileURLToPath(new URL("../../../var", import.meta.url));
const defaultKernelScript = fileURLToPath(new URL("../../../python/kernel_server.py", import.meta.url));
const defaultWasiRunner = fileURLToPath(new URL("../../wasi-runner/dist/main.js", import.meta.url));
const defaultCanvasRoot = fileURLToPath(new URL("../../canvas-web/dist", import.meta.url));
const homePath = resolve(process.env.HAF_HOME ?? defaultHomePath);
const provider = process.env.HAF_MODEL_PROVIDER ?? "mock";
const parsedModelApiKeys = process.env.HAF_MODEL_API_KEYS_JSON
  ? z.array(z.union([
      z.string().min(1).transform((apiKey) => ({ apiKey })),
      z.object({ id: z.string().min(1).max(100).optional(), apiKey: z.string().min(1) }),
    ])).min(1).max(32).parse(JSON.parse(process.env.HAF_MODEL_API_KEYS_JSON))
  : undefined;
const modelApiKeys = parsedModelApiKeys?.map((credential) =>
  "id" in credential && credential.id ? { id: credential.id, apiKey: credential.apiKey } : { apiKey: credential.apiKey },
);
const modelFallbacks = (process.env.HAF_MODEL_FALLBACKS ?? "")
  .split(",")
  .map((route) => route.trim())
  .filter(Boolean);
const environmentInteger = (name: string, fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).parse(process.env[name] ?? fallback);
const webSearchProvider = z.enum(["brave", "tavily"]).parse(process.env.HAF_WEB_SEARCH_PROVIDER ?? "brave");
const externalMemoryProvider = z.enum(["", "honcho"]).parse(process.env.HAF_MEMORY_PROVIDER ?? "");
if (provider === "openai-codex" && !process.env.HAF_MODEL_NAME) throw new Error("HAF_MODEL_NAME is required for openai-codex because the subscription catalog is account-specific.");
const model: NonNullable<EngineConfig["model"]> = provider === "mock"
  ? { provider: "mock", ...(process.env.HAF_MODEL_NAME ? { modelName: process.env.HAF_MODEL_NAME } : {}) }
  : provider === "openai-codex"
    ? {
        provider: "codex-subscription",
        modelName: process.env.HAF_MODEL_NAME!,
        ...(process.env.HAF_CODEX_REASONING_EFFORT ? { reasoningEffort: z.enum(["low", "medium", "high", "max"]).parse(process.env.HAF_CODEX_REASONING_EFFORT) } : {}),
        ...(process.env.HAF_CODEX_REQUEST_TIMEOUT_MS ? { requestTimeoutMs: environmentInteger("HAF_CODEX_REQUEST_TIMEOUT_MS", 180_000, 5_000, 600_000) } : {}),
      }
  : provider === "openai-compatible"
    ? {
        provider: "openai-compatible",
        baseUrl: process.env.HAF_MODEL_BASE_URL ?? "https://api.openai.com/v1",
        ...(process.env.HAF_MODEL_API_KEY ? { apiKey: process.env.HAF_MODEL_API_KEY } : {}),
        modelName: process.env.HAF_MODEL_NAME ?? "gpt-4.1-mini",
      }
    : {
        provider: "profile",
        profileId: provider,
        ...(process.env.HAF_MODEL_BASE_URL ? { baseUrl: process.env.HAF_MODEL_BASE_URL } : {}),
        ...(process.env.HAF_MODEL_API_KEY ? { apiKey: process.env.HAF_MODEL_API_KEY } : {}),
        ...(modelApiKeys?.length ? { apiKeys: modelApiKeys } : {}),
        ...(process.env.HAF_MODEL_NAME ? { modelName: process.env.HAF_MODEL_NAME } : {}),
        ...(process.env.HAF_MODEL_API_VERSION ? { apiVersion: process.env.HAF_MODEL_API_VERSION } : {}),
        ...(process.env.HAF_MODEL_REGION ? { region: process.env.HAF_MODEL_REGION } : {}),
      };

let learningTrustedKeys: Record<string, string> | undefined;
if (process.env.HAF_LEARNING_TRUSTED_KEYS_JSON) {
  const parsed = JSON.parse(process.env.HAF_LEARNING_TRUSTED_KEYS_JSON) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error("HAF_LEARNING_TRUSTED_KEYS_JSON must be a JSON object of key-id to Ed25519 public key.");
  }
  learningTrustedKeys = parsed as Record<string, string>;
}
let wasiTrustedKeys: Record<string, string> | undefined;
if (process.env.HAF_WASI_TRUSTED_KEYS_JSON) {
  const parsed = JSON.parse(process.env.HAF_WASI_TRUSTED_KEYS_JSON) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error("HAF_WASI_TRUSTED_KEYS_JSON must be a JSON object of key-id to Ed25519 public key.");
  }
  wasiTrustedKeys = parsed as Record<string, string>;
}
let otlpHeaders: Record<string, string> | undefined;
if (process.env.HAF_OTLP_HEADERS_JSON) {
  const parsed = JSON.parse(process.env.HAF_OTLP_HEADERS_JSON) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error("HAF_OTLP_HEADERS_JSON must be a JSON object of string headers.");
  }
  otlpHeaders = parsed as Record<string, string>;
}
const requestedSandbox = process.env.HAF_SANDBOX_BACKEND ?? "local";
const sandboxBackend: EngineConfig["sandboxBackend"] = (["local", "docker", "singularity", "ssh", "modal", "daytona", "vercel", "kubernetes"] as const).includes(requestedSandbox as any)
  ? requestedSandbox as EngineConfig["sandboxBackend"]
  : "local";
const cloudSandbox = (["modal", "daytona", "vercel", "kubernetes"] as string[]).includes(sandboxBackend);
if (sandboxBackend === "ssh" && !process.env.HAF_SSH_HOST) throw new Error("HAF_SSH_HOST is required for the SSH sandbox.");
if (sandboxBackend === "singularity" && !process.env.HAF_SINGULARITY_IMAGE) throw new Error("HAF_SINGULARITY_IMAGE is required for the Singularity sandbox.");
if (cloudSandbox && !process.env.HAF_CLOUD_SANDBOX_GATEWAY) throw new Error("HAF_CLOUD_SANDBOX_GATEWAY is required for cloud sandbox backends.");
const engine = new HybridAgentEngine({
  homePath,
  kernelServerScript: resolve(process.env.HAF_KERNEL_SERVER ?? defaultKernelScript),
  sandboxBackend,
  ...(sandboxBackend === "ssh"
    ? {
        sshSandbox: {
          host: process.env.HAF_SSH_HOST!,
          ...(process.env.HAF_SSH_USER ? { user: process.env.HAF_SSH_USER } : {}),
          ...(process.env.HAF_SSH_PORT ? { port: Number(process.env.HAF_SSH_PORT) } : {}),
          ...(process.env.HAF_SSH_IDENTITY_FILE ? { identityFile: process.env.HAF_SSH_IDENTITY_FILE } : {}),
          ...(process.env.HAF_SSH_REMOTE_ROOT ? { remoteRoot: process.env.HAF_SSH_REMOTE_ROOT } : {}),
          syncFiles: process.env.HAF_SSH_SYNC_FILES !== "false",
        },
      }
    : {}),
  ...(sandboxBackend === "singularity"
    ? {
        singularitySandbox: {
          image: process.env.HAF_SINGULARITY_IMAGE!,
          ...(process.env.HAF_SINGULARITY_EXECUTABLE ? { executable: process.env.HAF_SINGULARITY_EXECUTABLE } : {}),
          ...(process.env.HAF_SINGULARITY_IMAGE_SHA256 ? { imageSha256: process.env.HAF_SINGULARITY_IMAGE_SHA256 } : {}),
          allowUnpinnedImage: process.env.HAF_SINGULARITY_ALLOW_UNPINNED === "true",
          network: process.env.HAF_SINGULARITY_NETWORK === "host" ? "host" : "none",
        },
      }
    : {}),
  ...(cloudSandbox
    ? {
        cloudSandbox: {
          provider: sandboxBackend as "modal" | "daytona" | "vercel" | "kubernetes",
          endpoint: process.env.HAF_CLOUD_SANDBOX_GATEWAY!,
          ...(process.env.HAF_CLOUD_SANDBOX_TOKEN ? { bearerToken: process.env.HAF_CLOUD_SANDBOX_TOKEN } : {}),
          ...(process.env.HAF_CLOUD_SANDBOX_TEMPLATE ? { template: process.env.HAF_CLOUD_SANDBOX_TEMPLATE } : {}),
          networkPolicy: (process.env.HAF_CLOUD_SANDBOX_NETWORK_POLICY as "none" | "allowlist" | "unrestricted" | undefined) ?? "none",
          ...(process.env.HAF_CLOUD_SANDBOX_ALLOWED_HOSTS ? { allowedHosts: process.env.HAF_CLOUD_SANDBOX_ALLOWED_HOSTS.split(",").map((value) => value.trim()).filter(Boolean) } : {}),
        },
      }
    : {}),
  autoApproveWorkspaceWrites: process.env.HAF_AUTO_APPROVE_WORKSPACE === "true",
  allowProcessExecution: process.env.HAF_ALLOW_PROCESS === "true",
  autoRefineEveryTurns: environmentInteger("HAF_AUTO_REFINE_EVERY_TURNS", 0, 0, 10_000),
  repositoryImport: {
    maxFiles: environmentInteger("HAF_REPOSITORY_MAX_FILES", 100_000, 1, 1_000_000),
    maxBytes: environmentInteger("HAF_REPOSITORY_MAX_BYTES", 2_147_483_648, 1_000_000, 20_000_000_000),
    timeoutMs: environmentInteger("HAF_REPOSITORY_TIMEOUT_MS", 300_000, 1000, 3_600_000),
  },
  agentMessaging: {
    maxChars: environmentInteger("HAF_AGENT_MESSAGE_MAX_CHARS", 16_384, 1, 100_000),
    maxPending: environmentInteger("HAF_AGENT_MESSAGE_MAX_PENDING", 20, 1, 1000),
    rateCapacity: environmentInteger("HAF_AGENT_MESSAGE_RATE_CAPACITY", 3, 1, 1000),
    rateRefillMs: environmentInteger("HAF_AGENT_MESSAGE_RATE_REFILL_MS", 1000, 10, 3_600_000),
  },
  // Code intelligence: LSP is enabled by default only on the local backend,
  // where the engine shares the workspace filesystem; set HAF_CODE_INTELLIGENCE_LSP=false
  // to force the toolchain path everywhere.
  codeIntelligence: {
    lsp: process.env.HAF_CODE_INTELLIGENCE_LSP !== "false" && sandboxBackend === "local",
    ...(process.env.HAF_CODE_INTELLIGENCE_LSP_SERVERS_JSON
      ? { serverBinaries: z.record(z.string(), z.string()).parse(JSON.parse(process.env.HAF_CODE_INTELLIGENCE_LSP_SERVERS_JSON)) }
      : {}),
    ...(process.env.HAF_CODE_INTELLIGENCE_LSP_MAX_SERVERS ? { maxLspServers: environmentInteger("HAF_CODE_INTELLIGENCE_LSP_MAX_SERVERS", 2, 1, 8) } : {}),
  },
  ...(process.env.HAF_MODEL_OAUTH_REDIRECT_URI ? { modelOAuthRedirectUri: process.env.HAF_MODEL_OAUTH_REDIRECT_URI } : {}),
  context: {
    maxMessageChars: environmentInteger("HAF_CONTEXT_MAX_CHARS", 80_000, 10_000, 2_000_000),
    rollingMicroCompaction: process.env.HAF_ROLLING_MICRO_COMPACTION !== "false",
    microCompaction: {
      protectedTailChars: environmentInteger("HAF_MICRO_COMPACTION_TAIL_CHARS", 36_000, 1_000, 2_000_000),
      maxMessagesPerWindow: environmentInteger("HAF_MICRO_COMPACTION_WINDOW_MESSAGES", 12, 2, 100),
      maxSummaryChars: environmentInteger("HAF_MICRO_COMPACTION_SUMMARY_CHARS", 1_200, 300, 8_000),
      maxCachedWindows: environmentInteger("HAF_MICRO_COMPACTION_CACHE_WINDOWS", 500, 10, 2_000),
    },
  },
  ...(externalMemoryProvider === "honcho" ? {
    externalMemory: {
      provider: "honcho" as const,
      ...(process.env.HONCHO_API_KEY ? { apiKey: process.env.HONCHO_API_KEY } : {}),
      ...(process.env.HONCHO_URL ? { baseURL: process.env.HONCHO_URL } : {}),
      ...(process.env.HONCHO_WORKSPACE_ID ? { workspaceId: process.env.HONCHO_WORKSPACE_ID } : {}),
      ...(process.env.HAF_HONCHO_USER_PEER ? { userPeer: process.env.HAF_HONCHO_USER_PEER } : {}),
      ...(process.env.HAF_HONCHO_ASSISTANT_PEER ? { assistantPeer: process.env.HAF_HONCHO_ASSISTANT_PEER } : {}),
      recallMode: z.enum(["hybrid", "context", "tools"]).parse(process.env.HAF_HONCHO_RECALL_MODE ?? "hybrid"),
      contextTokens: environmentInteger("HAF_HONCHO_CONTEXT_TOKENS", 2_000, 100, 20_000),
      contextCadence: environmentInteger("HAF_HONCHO_CONTEXT_CADENCE", 1, 1, 100),
      messageMaxChars: environmentInteger("HAF_HONCHO_MESSAGE_MAX_CHARS", 25_000, 1_000, 25_000),
      timeoutMs: environmentInteger("HAF_HONCHO_TIMEOUT_MS", 8_000, 500, 60_000),
      maxRetries: environmentInteger("HAF_HONCHO_MAX_RETRIES", 0, 0, 5),
      allowSelfHosted: process.env.HAF_HONCHO_ALLOW_SELF_HOSTED === "true",
      allowPrivateBaseUrl: process.env.HAF_HONCHO_ALLOW_PRIVATE_BASE_URL === "true",
    },
  } : {}),
  ...(process.env.HAF_MASTER_KEY ? { masterKey: process.env.HAF_MASTER_KEY } : {}),
  ...(process.env.HAF_VAULT_ADDRESS && process.env.HAF_VAULT_TOKEN
    ? {
        vault: {
          address: process.env.HAF_VAULT_ADDRESS,
          token: process.env.HAF_VAULT_TOKEN,
          ...(process.env.HAF_VAULT_NAMESPACE ? { namespace: process.env.HAF_VAULT_NAMESPACE } : {}),
          ...(process.env.HAF_VAULT_MOUNT ? { mount: process.env.HAF_VAULT_MOUNT } : {}),
          ...(process.env.HAF_VAULT_PREFIX ? { prefix: process.env.HAF_VAULT_PREFIX } : {}),
        },
      }
    : {}),
  ...(process.env.HAF_EMBEDDING_API_KEY
    ? {
        embeddings: {
          apiKey: process.env.HAF_EMBEDDING_API_KEY,
          ...(process.env.HAF_EMBEDDING_BASE_URL ? { baseUrl: process.env.HAF_EMBEDDING_BASE_URL } : {}),
          ...(process.env.HAF_EMBEDDING_MODEL ? { model: process.env.HAF_EMBEDDING_MODEL } : {}),
          ...(process.env.HAF_EMBEDDING_DIMENSIONS ? { dimensions: Number(process.env.HAF_EMBEDDING_DIMENSIONS) } : {}),
        },
      }
    : {}),
  ...(process.env.HAF_POSTGRES_URL
    ? {
        postgres: {
          connectionString: process.env.HAF_POSTGRES_URL,
          schema: process.env.HAF_POSTGRES_SCHEMA ?? "haf",
          enableNotify: process.env.HAF_POSTGRES_NOTIFY !== "false",
          enableRls: process.env.HAF_POSTGRES_RLS === "true",
        },
      }
    : {}),
  ...(process.env.HAF_NATS_SERVERS
    ? {
        nats: {
          servers: process.env.HAF_NATS_SERVERS.split(",").map((value) => value.trim()).filter(Boolean),
          ...(process.env.HAF_NATS_TOKEN ? { token: process.env.HAF_NATS_TOKEN } : {}),
          ...(process.env.HAF_NATS_USER ? { user: process.env.HAF_NATS_USER } : {}),
          ...(process.env.HAF_NATS_PASS ? { pass: process.env.HAF_NATS_PASS } : {}),
          prefix: process.env.HAF_NATS_PREFIX ?? "haf",
        },
      }
    : {}),
  ...(learningTrustedKeys ? { learningTrustedKeys } : {}),
  ...(process.env.HAF_HOSTED_SCHEDULER_PORTAL_URL && process.env.HAF_HOSTED_SCHEDULER_ACCESS_TOKEN && process.env.HAF_HOSTED_SCHEDULER_CALLBACK_URL && process.env.HAF_HOSTED_SCHEDULER_AUDIENCE && process.env.HAF_HOSTED_SCHEDULER_ISSUER && process.env.HAF_HOSTED_SCHEDULER_JWKS_URL
    ? { hostedScheduler: {
        portalUrl: process.env.HAF_HOSTED_SCHEDULER_PORTAL_URL,
        accessToken: process.env.HAF_HOSTED_SCHEDULER_ACCESS_TOKEN,
        callbackUrl: process.env.HAF_HOSTED_SCHEDULER_CALLBACK_URL,
        expectedAudience: process.env.HAF_HOSTED_SCHEDULER_AUDIENCE,
        issuer: process.env.HAF_HOSTED_SCHEDULER_ISSUER,
        jwksUrl: process.env.HAF_HOSTED_SCHEDULER_JWKS_URL,
      } }
    : {}),
  ...(wasiTrustedKeys
    ? {
        wasiPlugins: {
          runnerPath: process.env.HAF_WASI_RUNNER_PATH ?? defaultWasiRunner,
          trustedPublicKeys: wasiTrustedKeys,
          defaultTimeoutMs: Number(process.env.HAF_WASI_TIMEOUT_MS ?? 5000),
          maxOutputBytes: Number(process.env.HAF_WASI_MAX_OUTPUT_BYTES ?? 1024 * 1024),
        },
      }
    : {}),
  ...(process.env.HAF_OPA_ENDPOINT
    ? {
        opa: {
          endpoint: process.env.HAF_OPA_ENDPOINT,
          ...(process.env.HAF_OPA_BEARER_TOKEN ? { bearerToken: process.env.HAF_OPA_BEARER_TOKEN } : {}),
          timeoutMs: Number(process.env.HAF_OPA_TIMEOUT_MS ?? 3000),
        },
      }
    : {}),
  ...(process.env.HAF_AUDIO_API_KEY
    ? {
        audio: {
          apiKey: process.env.HAF_AUDIO_API_KEY,
          ...(process.env.HAF_AUDIO_BASE_URL ? { baseUrl: process.env.HAF_AUDIO_BASE_URL } : {}),
          ...(process.env.HAF_STT_MODEL ? { transcriptionModel: process.env.HAF_STT_MODEL } : {}),
          ...(process.env.HAF_TTS_MODEL ? { speechModel: process.env.HAF_TTS_MODEL } : {}),
          ...(process.env.HAF_TTS_VOICE ? { defaultVoice: process.env.HAF_TTS_VOICE } : {}),
        },
      }
    : {}),
  ...(process.env.HAF_IMAGE_API_KEY
    ? {
        images: {
          apiKey: process.env.HAF_IMAGE_API_KEY,
          ...(process.env.HAF_IMAGE_BASE_URL ? { baseUrl: process.env.HAF_IMAGE_BASE_URL } : {}),
          ...(process.env.HAF_IMAGE_MODEL ? { model: process.env.HAF_IMAGE_MODEL } : {}),
          ...(process.env.HAF_IMAGE_QUALITY ? { quality: z.enum(["low", "medium", "high", "auto"]).parse(process.env.HAF_IMAGE_QUALITY) } : {}),
          ...(process.env.HAF_IMAGE_MAX_BYTES ? { maxImageBytes: Number(process.env.HAF_IMAGE_MAX_BYTES) } : {}),
          allowRemoteImageUrls: process.env.HAF_IMAGE_ALLOW_REMOTE_URLS === "true",
        },
      }
    : {}),
  ...(process.env.HAF_FAL_IMAGE_API_KEY && process.env.HAF_FAL_IMAGE_MODEL
    ? {
        falImages: {
          apiKey: process.env.HAF_FAL_IMAGE_API_KEY,
          model: process.env.HAF_FAL_IMAGE_MODEL,
          ...(process.env.HAF_FAL_IMAGE_EDIT_MODEL ? { editModel: process.env.HAF_FAL_IMAGE_EDIT_MODEL } : {}),
          ...(process.env.HAF_FAL_IMAGE_BASE_URL ? { baseUrl: process.env.HAF_FAL_IMAGE_BASE_URL } : {}),
        },
      }
    : {}),
  ...(process.env.HAF_IMAGE_UPSCALE_API_KEY && process.env.HAF_IMAGE_UPSCALE_MODEL
    ? {
        imageUpscale: {
          apiKey: process.env.HAF_IMAGE_UPSCALE_API_KEY,
          model: process.env.HAF_IMAGE_UPSCALE_MODEL,
          ...(process.env.HAF_IMAGE_UPSCALE_BASE_URL ? { baseUrl: process.env.HAF_IMAGE_UPSCALE_BASE_URL } : {}),
        },
      }
    : {}),
  ...(process.env.HAF_VIDEO_API_KEY && process.env.HAF_VIDEO_MODEL
    ? {
        video: {
          apiKey: process.env.HAF_VIDEO_API_KEY,
          model: process.env.HAF_VIDEO_MODEL,
          ...(process.env.HAF_VIDEO_BASE_URL ? { baseUrl: process.env.HAF_VIDEO_BASE_URL } : {}),
          ...(process.env.HAF_VIDEO_MAX_BYTES ? { maxVideoBytes: environmentInteger("HAF_VIDEO_MAX_BYTES", 104_857_600, 1_000_000, 1_000_000_000) } : {}),
          allowRemoteVideoUrls: process.env.HAF_VIDEO_ALLOW_REMOTE_URLS === "true",
        },
      }
    : {}),
  ...(process.env.HAF_VIDEO_UPSCALE_API_KEY && process.env.HAF_VIDEO_UPSCALE_MODEL
    ? {
        videoUpscale: {
          apiKey: process.env.HAF_VIDEO_UPSCALE_API_KEY,
          model: process.env.HAF_VIDEO_UPSCALE_MODEL,
          ...(process.env.HAF_VIDEO_UPSCALE_BASE_URL ? { baseUrl: process.env.HAF_VIDEO_UPSCALE_BASE_URL } : {}),
        },
      }
    : {}),
  ...(process.env.HAF_VIDEO_QUEUE_API_KEY && process.env.HAF_VIDEO_QUEUE_MODEL
    ? {
        queuedVideo: {
          apiKey: process.env.HAF_VIDEO_QUEUE_API_KEY,
          model: process.env.HAF_VIDEO_QUEUE_MODEL,
          ...(process.env.HAF_VIDEO_QUEUE_BASE_URL ? { baseUrl: process.env.HAF_VIDEO_QUEUE_BASE_URL } : {}),
        },
      }
    : {}),
  ...(process.env.HAF_WEB_SEARCH_API_KEY
    ? {
        webSearch: webSearchProvider === "tavily"
          ? {
              provider: "tavily" as const,
              apiKey: process.env.HAF_WEB_SEARCH_API_KEY,
              ...(process.env.HAF_WEB_SEARCH_BASE_URL ? { baseUrl: process.env.HAF_WEB_SEARCH_BASE_URL } : {}),
              searchDepth: process.env.HAF_WEB_SEARCH_DEPTH === "advanced" ? "advanced" as const : "basic" as const,
            }
          : {
              provider: "brave" as const,
              apiKey: process.env.HAF_WEB_SEARCH_API_KEY,
              ...(process.env.HAF_WEB_SEARCH_BASE_URL ? { baseUrl: process.env.HAF_WEB_SEARCH_BASE_URL } : {}),
              ...(process.env.HAF_WEB_SEARCH_COUNTRY ? { country: process.env.HAF_WEB_SEARCH_COUNTRY } : {}),
              ...(process.env.HAF_WEB_SEARCH_LANGUAGE ? { language: process.env.HAF_WEB_SEARCH_LANGUAGE } : {}),
            },
      }
    : {}),
  ...((process.env.HAF_BROWSER_CDP_ENDPOINT || process.env.HAF_BROWSER_EXECUTABLE_PATH)
    ? {
        browser: {
          ...(process.env.HAF_BROWSER_CDP_ENDPOINT ? { cdpEndpoint: process.env.HAF_BROWSER_CDP_ENDPOINT } : {}),
          ...(process.env.HAF_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.HAF_BROWSER_EXECUTABLE_PATH } : {}),
          headless: process.env.HAF_BROWSER_HEADLESS !== "false",
          allowPrivateCdpEndpoint: process.env.HAF_BROWSER_ALLOW_PRIVATE_CDP === "true",
        },
      }
    : {}),
  ...(process.env.HAF_OTLP_ENDPOINT
    ? {
        otlp: {
          endpoint: process.env.HAF_OTLP_ENDPOINT,
          ...(otlpHeaders ? { headers: otlpHeaders } : {}),
          intervalMs: Number(process.env.HAF_OTLP_INTERVAL_MS ?? 60_000),
          serviceVersion: ENGINE_VERSION,
        },
      }
    : {}),
  ...(modelFallbacks.length ? { modelFallbacks } : {}),
  model,
});
if (process.env.TELEGRAM_BOT_TOKEN) engine.outboundChannels.register(new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN));
if (process.env.DISCORD_BOT_TOKEN) engine.outboundChannels.register(new DiscordBotAdapter(process.env.DISCORD_BOT_TOKEN));
if (process.env.SLACK_BOT_TOKEN) engine.outboundChannels.register(new SlackAdapter(process.env.SLACK_BOT_TOKEN));
if (process.env.WHATSAPP_CLOUD_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
  engine.outboundChannels.register(new WhatsAppCloudAdapter(process.env.WHATSAPP_CLOUD_TOKEN, process.env.WHATSAPP_PHONE_NUMBER_ID));
}
if (process.env.MATRIX_HOMESERVER && process.env.MATRIX_ACCESS_TOKEN) {
  engine.outboundChannels.register(new MatrixAdapter(process.env.MATRIX_HOMESERVER, process.env.MATRIX_ACCESS_TOKEN));
}
if (process.env.SIGNAL_REST_URL && process.env.SIGNAL_SENDER_NUMBER) {
  engine.outboundChannels.register(new SignalRestAdapter(
    process.env.SIGNAL_REST_URL,
    process.env.SIGNAL_SENDER_NUMBER,
    process.env.SIGNAL_REST_TOKEN,
  ));
}
if (process.env.MATTERMOST_URL && process.env.MATTERMOST_BOT_TOKEN) {
  engine.outboundChannels.register(new MattermostAdapter(process.env.MATTERMOST_URL, process.env.MATTERMOST_BOT_TOKEN, process.env.MATTERMOST_ALLOW_LOOPBACK_HTTP === "true"));
}
if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
  engine.outboundChannels.register(new LineMessagingAdapter(process.env.LINE_CHANNEL_ACCESS_TOKEN, process.env.LINE_API_BASE));
}
if (process.env.GOOGLE_CHAT_ACCESS_TOKEN) {
  engine.outboundChannels.register(new GoogleChatAdapter(process.env.GOOGLE_CHAT_ACCESS_TOKEN, process.env.GOOGLE_CHAT_API_BASE));
}
if (process.env.TEAMS_ACCESS_TOKEN) {
  engine.outboundChannels.register(new MicrosoftTeamsAdapter(process.env.TEAMS_ACCESS_TOKEN, process.env.TEAMS_GRAPH_BASE));
}
if (process.env.FEISHU_TENANT_ACCESS_TOKEN) {
  engine.outboundChannels.register(new FeishuAdapter(process.env.FEISHU_TENANT_ACCESS_TOKEN, process.env.FEISHU_API_BASE));
}
if (process.env.IRC_HOST) {
  if (!process.env.IRC_NICKNAME) throw new Error("IRC_NICKNAME is required when IRC_HOST is configured.");
  const channels = (process.env.IRC_CHANNELS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const allowedNicknames = (process.env.IRC_ALLOWED_NICKNAMES ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const allowedAccounts = (process.env.IRC_ALLOWED_ACCOUNTS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!channels.length) throw new Error("IRC_CHANNELS requires at least one channel.");
  if (!allowedNicknames.length && !allowedAccounts.length) throw new Error("IRC requires IRC_ALLOWED_NICKNAMES or IRC_ALLOWED_ACCOUNTS.");
  if (Boolean(process.env.IRC_SASL_ACCOUNT) !== Boolean(process.env.IRC_SASL_PASSWORD)) throw new Error("IRC SASL requires both IRC_SASL_ACCOUNT and IRC_SASL_PASSWORD.");
  let ircTlsCa: Buffer | undefined;
  if (process.env.IRC_TLS_CA_PATH) {
    ircTlsCa = await readFile(resolve(process.env.IRC_TLS_CA_PATH));
    if (ircTlsCa.length > 1024 * 1024 || !ircTlsCa.toString("utf8").includes("-----BEGIN CERTIFICATE-----")) throw new Error("IRC_TLS_CA_PATH must reference a bounded PEM certificate bundle.");
  }
  engine.outboundChannels.register(new IrcChannelAdapter({
    gateway: engine.channels,
    tenantId: process.env.IRC_TENANT_ID ?? "local",
    host: process.env.IRC_HOST,
    port: environmentInteger("IRC_PORT", process.env.IRC_TLS === "false" ? 6667 : 6697, 1, 65535),
    tls: process.env.IRC_TLS !== "false",
    allowPlaintext: process.env.IRC_ALLOW_PLAINTEXT === "true",
    allowPrivateHost: process.env.IRC_ALLOW_PRIVATE_HOST === "true",
    ...(ircTlsCa ? { tlsCa: ircTlsCa } : {}),
    nickname: process.env.IRC_NICKNAME,
    ...(process.env.IRC_USERNAME ? { username: process.env.IRC_USERNAME } : {}),
    ...(process.env.IRC_REAL_NAME ? { realName: process.env.IRC_REAL_NAME } : {}),
    channels,
    allowedNicknames,
    allowedAccounts,
    ...(process.env.IRC_SERVER_PASSWORD ? { serverPassword: process.env.IRC_SERVER_PASSWORD } : {}),
    ...(process.env.IRC_SASL_ACCOUNT && process.env.IRC_SASL_PASSWORD ? { sasl: { account: process.env.IRC_SASL_ACCOUNT, password: process.env.IRC_SASL_PASSWORD } } : {}),
    reconnectMinMs: environmentInteger("IRC_RECONNECT_MIN_MS", 1000, 100, 60_000),
    reconnectMaxMs: environmentInteger("IRC_RECONNECT_MAX_MS", 60_000, 100, 600_000),
    outboundIntervalMs: environmentInteger("IRC_OUTBOUND_INTERVAL_MS", 800, 0, 10_000),
  }));
}
const emailRequested = Boolean(process.env.EMAIL_SMTP_HOST || process.env.EMAIL_IMAP_HOST);
if (emailRequested) {
  for (const name of ["EMAIL_SMTP_HOST", "EMAIL_SMTP_USERNAME", "EMAIL_SMTP_PASSWORD", "EMAIL_FROM_ADDRESS"] as const) {
    if (!process.env[name]) throw new Error(`${name} is required when email transport is configured.`);
  }
  const allowedRecipients = (process.env.EMAIL_ALLOWED_RECIPIENTS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const allowedSenders = (process.env.EMAIL_ALLOWED_SENDERS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!allowedRecipients.length) throw new Error("EMAIL_ALLOWED_RECIPIENTS requires at least one address.");
  if (process.env.EMAIL_IMAP_HOST && (!process.env.EMAIL_IMAP_USERNAME || !process.env.EMAIL_IMAP_PASSWORD || !process.env.EMAIL_INBOUND_TOKEN || !allowedSenders.length)) {
    throw new Error("Inbound email requires IMAP username/password, EMAIL_INBOUND_TOKEN and EMAIL_ALLOWED_SENDERS.");
  }
  const readEmailCa = async (environmentVariable: string): Promise<Buffer | undefined> => {
    const path = process.env[environmentVariable];
    if (!path) return undefined;
    const data = await readFile(resolve(path));
    if (data.length > 1024 * 1024 || !data.toString("utf8").includes("-----BEGIN CERTIFICATE-----")) throw new Error(`${environmentVariable} must reference a bounded PEM certificate bundle.`);
    return data;
  };
  const smtpCa = await readEmailCa("EMAIL_SMTP_TLS_CA_PATH");
  const imapCa = await readEmailCa("EMAIL_IMAP_TLS_CA_PATH");
  const smtpSecure = process.env.EMAIL_SMTP_SECURE === "true";
  const imapSecure = process.env.EMAIL_IMAP_SECURE !== "false";
  engine.outboundChannels.register(new EmailChannelAdapter({
    stateRoot: resolve(homePath, "data"), gateway: engine.channels,
    tenantId: process.env.EMAIL_TENANT_ID ?? "local",
    smtp: {
      host: process.env.EMAIL_SMTP_HOST!,
      port: environmentInteger("EMAIL_SMTP_PORT", smtpSecure ? 465 : 587, 1, 65535),
      secure: smtpSecure, username: process.env.EMAIL_SMTP_USERNAME!, password: process.env.EMAIL_SMTP_PASSWORD!,
      fromAddress: process.env.EMAIL_FROM_ADDRESS!,
      ...(process.env.EMAIL_FROM_NAME ? { fromName: process.env.EMAIL_FROM_NAME } : {}),
      ...(smtpCa ? { tlsCa: smtpCa } : {}),
    },
    ...(process.env.EMAIL_IMAP_HOST ? { imap: {
      host: process.env.EMAIL_IMAP_HOST,
      port: environmentInteger("EMAIL_IMAP_PORT", imapSecure ? 993 : 143, 1, 65535),
      secure: imapSecure, username: process.env.EMAIL_IMAP_USERNAME!, password: process.env.EMAIL_IMAP_PASSWORD!,
      mailbox: process.env.EMAIL_IMAP_MAILBOX ?? "INBOX", inboundToken: process.env.EMAIL_INBOUND_TOKEN!,
      recipientAddresses: (process.env.EMAIL_INBOUND_RECIPIENTS ?? process.env.EMAIL_FROM_ADDRESS!).split(",").map((item) => item.trim()).filter(Boolean),
      initialSync: process.env.EMAIL_INITIAL_SYNC === "all" ? "all" as const : "latest" as const,
      ...(imapCa ? { tlsCa: imapCa } : {}),
    } } : {}),
    allowedRecipients, allowedSenders,
    allowPrivateHost: process.env.EMAIL_ALLOW_PRIVATE_HOST === "true",
    pollIntervalMs: environmentInteger("EMAIL_POLL_INTERVAL_MS", 30_000, 1000, 600_000),
    reconnectMinMs: environmentInteger("EMAIL_RECONNECT_MIN_MS", 1000, 100, 60_000),
    reconnectMaxMs: environmentInteger("EMAIL_RECONNECT_MAX_MS", 60_000, 100, 600_000),
    connectTimeoutMs: environmentInteger("EMAIL_CONNECT_TIMEOUT_MS", 15_000, 1000, 120_000),
    maxMessageBytes: environmentInteger("EMAIL_MAX_MESSAGE_BYTES", 2_097_152, 1024, 20_971_520),
    maxBodyChars: environmentInteger("EMAIL_MAX_BODY_CHARS", 20_000, 1000, 100_000),
    maxMessagesPerPoll: environmentInteger("EMAIL_MAX_MESSAGES_PER_POLL", 50, 1, 500),
    autoReply: process.env.EMAIL_AUTO_REPLY !== "false",
  }));
}
let twilioSmsAdapter: TwilioSmsAdapter | undefined;
const twilioRequested = Boolean(process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_FROM_NUMBER);
if (twilioRequested) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) {
    throw new Error("Twilio SMS requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.");
  }
  const allowedNumbers = (process.env.TWILIO_ALLOWED_NUMBERS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!allowedNumbers.length) throw new Error("TWILIO_ALLOWED_NUMBERS requires at least one E.164 number.");
  twilioSmsAdapter = new TwilioSmsAdapter({
    stateRoot: resolve(homePath, "data"), gateway: engine.channels,
    tenantId: process.env.TWILIO_TENANT_ID ?? "local",
    accountSid: process.env.TWILIO_ACCOUNT_SID, authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER, allowedNumbers,
    ...(process.env.TWILIO_WEBHOOK_URL ? { webhookUrl: process.env.TWILIO_WEBHOOK_URL } : {}),
    ...(process.env.TWILIO_API_BASE ? { apiBase: process.env.TWILIO_API_BASE } : {}),
  });
  engine.outboundChannels.register(twilioSmsAdapter);
}
if (process.env.HAF_OUTBOUND_WEBHOOK_URL && process.env.HAF_OUTBOUND_WEBHOOK_SECRET) {
  engine.outboundChannels.register(new SignedWebhookAdapter(
    "webhook",
    process.env.HAF_OUTBOUND_WEBHOOK_URL,
    process.env.HAF_OUTBOUND_WEBHOOK_SECRET,
  ));
}
await engine.initialize();
engine.start();
const detachedWorkerEntrypoint = fileURLToPath(new URL("../../session-worker/dist/main.js", import.meta.url));
const detachedWorkers = new WorkerProcessManager(resolve(homePath, "data", "worker-control"));
const fleetMonitor = new FleetMonitor(engine.metrics, engine.scheduler, engine.approvals, {
  workerProbe: async () => {
    const workers = await detachedWorkers.adoptAll(false);
    return {
      running: workers.filter((item) => item.status === "adopted").length,
      recovered: workers.filter((item) => item.status === "recovered").length,
      stale: workers.filter((item) => item.status === "stale").length,
      unreachable: 0,
    };
  },
  capabilityFailureRateWarning: Number(process.env.HAF_ALERT_CAPABILITY_FAILURE_RATE ?? 0.2),
  approvalAgeWarningSeconds: Number(process.env.HAF_ALERT_APPROVAL_AGE_SECONDS ?? 300),
});

const googleChatJwtVerifier = process.env.GOOGLE_CHAT_AUDIENCE
  ? new PlatformJwtVerifier({
      audience: process.env.GOOGLE_CHAT_AUDIENCE,
      issuers: ["https://accounts.google.com", "accounts.google.com"],
      jwksUrl: process.env.GOOGLE_CHAT_JWKS_URL ?? "https://www.googleapis.com/oauth2/v3/certs",
    })
  : undefined;
const teamsJwtVerifier = process.env.TEAMS_APP_ID && process.env.TEAMS_JWT_ISSUER && process.env.TEAMS_JWKS_URL
  ? new PlatformJwtVerifier({
      audience: process.env.TEAMS_APP_ID,
      issuers: process.env.TEAMS_JWT_ISSUER.split(",").map((item) => item.trim()).filter(Boolean),
      jwksUrl: process.env.TEAMS_JWKS_URL,
    })
  : undefined;
const app = Fastify({ logger: true, bodyLimit: 4 * 1024 * 1024 });
await app.register(cors, {
  origin: process.env.HAF_CORS_ORIGIN ? process.env.HAF_CORS_ORIGIN.split(",") : false,
  credentials: true,
});
await app.register(cookie);
await app.register(formbody, { bodyLimit: 1024 * 1024 });
await app.register(rawBody, { field: "rawBody", global: true, encoding: false, runFirst: true });
const canvasRoot = resolve(process.env.HAF_CANVAS_ROOT ?? defaultCanvasRoot);
await app.register(staticPlugin, {
  root: canvasRoot,
  prefix: "/canvas/",
  wildcard: false,
  index: ["index.html"],
  cacheControl: true,
  maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
});
app.addHook("onSend", async (request, reply, payload) => {
  if (request.url.startsWith("/canvas")) {
    reply.header("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  }
  return payload;
});

// Helper function for session capability execution (must be before route registration)
async function executeSessionCapability(
  sessionId: string,
  capabilityId: string,
  input: unknown,
  source: "web" | "api" = "web",
  idempotencyKey?: string,
) {
  const session = await engine.session(sessionId);
  try {
    return await engine.capabilities.execute(capabilityId, input, {
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      familyId: session.familyId,
      turnId: `bff:${randomUUID()}`,
      toolCallId: randomUUID(),
      source,
      workspacePath: session.workspacePath,
      idempotencyKey: idempotencyKey && /^[A-Za-z0-9_.:-]{8,200}$/.test(idempotencyKey)
        ? `bff:${sessionId}:${capabilityId}:${idempotencyKey}`
        : `bff:${sessionId}:${capabilityId}:${randomUUID()}`,
    });
  } catch (error) {
    // A capability that ran and failed is a different answer from "the server
    // broke": the session is named, the capability is named, and the caller can
    // decide whether the same call is worth repeating.
    if (error instanceof AppError) throw error;
    throw new AppError(
      "SESSION_EXECUTION_FAILED",
      {
        sessionId,
        capabilityId,
        reason: error instanceof Error ? error.message : String(error),
      },
      error instanceof Error ? error : undefined,
    );
  }
}

// Register middleware (security, rate limiting, error handling, audit logging)
await registerErrorHandler(app);
await registerSecurityHeaders(app);
await registerRateLimiting(app);
await registerAuditLogger(app);

registerAuroraServiceErrorTyping(app);


// Note: Route endpoints remain inline in this file for API compatibility.
// The modular route files in ./routes/ serve as reference implementations
// and can be migrated incrementally with proper auroraInput() helper support.

const apiToken = process.env.HAF_API_TOKEN?.trim();
const oidcConfigured = Boolean(process.env.HAF_OIDC_ISSUER && process.env.HAF_OIDC_CLIENT_ID && process.env.HAF_OIDC_REDIRECT_URI);
const authDisabled = process.env.HAF_AUTH_DISABLED === "true" || (!apiToken && !oidcConfigured);
const sessionSecret = process.env.HAF_SESSION_SECRET ?? apiToken ?? (authDisabled ? "development-only-session-secret-change-me" : "");
if (!sessionSecret) throw new Error("HAF_SESSION_SECRET is required when authentication is enabled.");
const cookieName = process.env.HAF_SESSION_COOKIE_NAME ?? "haf_session";

const identityService = new IdentityService({
  sessionFile: resolve(homePath, "data", "auth", "sessions.enc"),
  sessionSecret,
  sessionTtlMs: Number(process.env.HAF_SESSION_TTL_MS ?? 8 * 60 * 60_000),
  ...(apiToken ? { apiToken } : {}),
  authDisabled,
  defaultTenant: process.env.HAF_DEFAULT_TENANT ?? "local",
  ...(oidcConfigured
    ? {
        oidc: {
          issuer: process.env.HAF_OIDC_ISSUER!,
          clientId: process.env.HAF_OIDC_CLIENT_ID!,
          ...(process.env.HAF_OIDC_CLIENT_SECRET ? { clientSecret: process.env.HAF_OIDC_CLIENT_SECRET } : {}),
          redirectUri: process.env.HAF_OIDC_REDIRECT_URI!,
          ...(process.env.HAF_OIDC_SCOPES ? { scopes: process.env.HAF_OIDC_SCOPES.split(" ").filter(Boolean) } : {}),
          ...(process.env.HAF_OIDC_TENANT_CLAIM ? { tenantClaim: process.env.HAF_OIDC_TENANT_CLAIM } : {}),
          ...(process.env.HAF_OIDC_ROLE_CLAIM ? { roleClaim: process.env.HAF_OIDC_ROLE_CLAIM } : {}),
        },
      }
    : {}),
});

// Maintenance mode, registered first so it gates authentication too.
registerMaintenance(app, {
  enabled: process.env.HAF_MAINTENANCE === "true",
  ...(process.env.HAF_MAINTENANCE === "true" ? { since: new Date().toISOString() } : {}),
  ...(process.env.HAF_MAINTENANCE_MESSAGE?.trim() ? { message: process.env.HAF_MAINTENANCE_MESSAGE.trim() } : {}),
});

// Request guards. Registered here, before any route is declared, so every route
// below is covered -- including the ones added by the route modules at the end.
const authState = registerAuthGuards(app, { identityService, cookieName, engine, oidcConfigured });

const sessionCookieOptions = {
  path: "/",
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.HAF_COOKIE_SECURE !== "false",
  maxAge: Math.floor(identityService.sessionTtlMs / 1000),
};


app.get("/auth/me", async (request, reply) => {
  const identity = authState.identity(request);
  if (!identity) return await reply.code(401).send({ authenticated: false, oidcConfigured });
  const session = authState.webSession(request);
  return {
    authenticated: identity.authType !== "anonymous-dev",
    developmentMode: identity.authType === "anonymous-dev",
    identity,
    ...(session ? { csrfToken: session.csrfToken, expiresAt: session.expiresAt } : {}),
    oidcConfigured,
  };
});

app.post("/auth/login/token", async (request, reply) => {
  const { token } = z.object({ token: z.string().min(1) }).parse(request.body);
  const identity = identityService.apiTokenIdentity(token);
  if (!identity) throw new AppError("AUTH_TOKEN_INVALID");
  const session = await identityService.createSession(identity);
  reply.setCookie(cookieName, session.id, sessionCookieOptions);
  return { identity: session.identity, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
});

app.get("/auth/oidc/start", async (request, reply) => {
  const { returnTo } = z.object({ returnTo: z.string().optional() }).parse(request.query);
  const start = await identityService.oidcStart(returnTo ?? "/");
  return await reply.redirect(start.url);
});

app.get("/auth/oidc/callback", async (request, reply) => {
  const { code, state } = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query);
  let result: Awaited<ReturnType<IdentityService["oidcCallback"]>>;
  try {
    result = await identityService.oidcCallback(code, state);
  } catch (error) {
    // Discovery, token exchange, signature verification and nonce checks all
    // surface here as plain Errors. They are upstream failures the caller cannot
    // fix by retrying the same request, which is a 502 and not a 500.
    throw new AppError(
      "AUTH_OIDC_ERROR",
      { reason: error instanceof Error ? error.message : String(error) },
      error instanceof Error ? error : undefined,
    );
  }
  reply.setCookie(cookieName, result.session.id, sessionCookieOptions);
  return await reply.redirect(result.returnTo);
});

app.get("/auth/mcp/callback", async (request, reply) => {
  const query = z.object({
    code: z.string().optional(),
    state: z.string().min(16),
    error: z.string().optional(),
  }).parse(request.query);
  if (query.error || !query.code) {
    const cancelled = await engine.mcp.cancelHttpOAuthByState(query.state);
    if (!cancelled) return await reply.code(400).send({ error: "mcp_oauth_state_missing_or_expired" });
    return await reply.redirect(`/canvas/?mcp_oauth=denied`);
  }
  try {
    await engine.mcp.finishHttpOAuthByState({ code: query.code, state: query.state });
    return await reply.redirect(`/canvas/?mcp_oauth=connected`);
  } catch (error) {
    if (error instanceof McpOAuthPendingNotFoundError) {
      return await reply.code(400).send({ error: "mcp_oauth_state_missing_or_expired" });
    }
    return await reply.redirect(`/canvas/?mcp_oauth=failed`);
  }
});

app.get("/auth/github-app/callback", async (request, reply) => {
  const query = z.object({
    state: z.string().min(16),
    installation_id: z.string().regex(/^\d{1,30}$/).optional(),
    setup_action: z.enum(["install", "update", "request"]).default("install"),
  }).parse(request.query);
  try {
    if (query.setup_action === "request") {
      const result = await engine.githubApps.markInstallationRequested(query.state);
      const returnTo = new URL(result.returnTo, "https://haf.invalid");
      returnTo.searchParams.set("github_app", "requested");
      return await reply.redirect(`${returnTo.pathname}${returnTo.search}${returnTo.hash}`);
    }
    if (!query.installation_id) return await reply.code(400).send({ error: "github_app_installation_id_missing" });
    const result = await engine.githubApps.finishInstallation({
      state: query.state, installationId: query.installation_id, setupAction: query.setup_action,
    });
    const returnTo = new URL(result.returnTo, "https://haf.invalid");
    returnTo.searchParams.set("github_app", "connected");
    returnTo.searchParams.set("installation", result.installation.id);
    return await reply.redirect(`${returnTo.pathname}${returnTo.search}${returnTo.hash}`);
  } catch (error) {
    if (error instanceof GitHubAppPendingNotFoundError) {
      return await reply.code(400).send({ error: "github_app_state_missing_or_expired" });
    }
    const fallback = new URL("/canvas/", "https://haf.invalid");
    fallback.searchParams.set("github_app", "failed");
    return await reply.redirect(`${fallback.pathname}${fallback.search}`);
  }
});

app.get("/auth/model-oauth/callback", async (request, reply) => {
  const query = z.object({ state: z.string().min(16), code: z.string().max(8192).optional(), error: z.string().max(500).optional() }).parse(request.query);
  try {
    const source = await engine.modelOAuth.finish({ state: query.state, ...(query.code ? { code: query.code } : {}), ...(query.error ? { error: query.error } : {}) });
    return await reply.redirect(`/canvas/?model_oauth=connected&source=${encodeURIComponent(source.id)}`);
  } catch (error) {
    if (error instanceof ModelOAuthPendingNotFoundError) return await reply.code(400).send({ error: "model_oauth_state_missing_or_expired" });
    if (error instanceof ModelOAuthError && error.code === "authorization_denied") return await reply.redirect("/canvas/?model_oauth=denied");
    return await reply.redirect("/canvas/?model_oauth=failed");
  }
});

app.post("/auth/logout", async (request, reply) => {
  const session = await identityService.getSession(request.cookies[cookieName]);
  if (session && request.headers["x-haf-csrf"] !== session.csrfToken) {
    return await reply.code(403).send({ error: "csrf_validation_failed" });
  }
  await identityService.logout(request.cookies[cookieName]);
  reply.clearCookie(cookieName, { path: "/" });
  return { loggedOut: true };
});

app.get("/canvas", async (_request, reply) => await reply.redirect("/canvas/"));
app.get("/canvas/*", async (_request, reply) => await reply.sendFile("index.html", canvasRoot));

app.get("/", async (_request, reply) => {
  return await reply
    .header("content-type", "text/html; charset=utf-8")
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("x-frame-options", "DENY")
    .send(dashboardHtml);
});

// T5: the observability group (health, SLO, explain, metrics, fleet) now
// lives in ./routes/observability.ts — extracted verbatim; the OpenAPI
// registration count must not move (862).
registerObservabilityRoutes(app, engine, z, { fleetMonitor, engineVersion: ENGINE_VERSION });

app.get("/v1/capabilities", async () => ({ capabilities: engine.capabilities.list() }));
app.get("/v1/society/roles", async (request) => { const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query); return { roles: await engine.society.roles(tenantId) }; });
app.post("/v1/society/roles", async (request, reply) => { const body = z.object({ tenantId: z.string().default("local"), name: z.string().min(1).max(200), layer: z.enum(["prime","council","specialist","micro"]), purpose: z.string().min(1).max(2000), capabilityTags: z.array(z.string()).max(100), parentRoleId: z.string().optional(), agentProfileId: z.string().optional() }).parse(request.body); return await reply.code(201).send(await engine.society.addRole({ tenantId: body.tenantId, name: body.name, layer: body.layer, purpose: body.purpose, capabilityTags: body.capabilityTags, ...(body.parentRoleId ? { parentRoleId: body.parentRoleId } : {}), ...(body.agentProfileId ? { agentProfileId: body.agentProfileId } : {}) })); });
app.post("/v1/society/roles/:roleId/profile", async (request) => { const { roleId } = z.object({ roleId: z.string() }).parse(request.params); const body = z.object({ tenantId: z.string().default("local"), agentProfileId: z.string().nullable() }).parse(request.body); return await engine.society.bindProfile(body.tenantId, roleId, body.agentProfileId ?? undefined); });
app.post("/v1/society/budget", async (request) => { const body = z.object({ tenantId: z.string().default("local"), dailyTokenBudget: z.number().int().min(1000), maxConcurrentTasks: z.number().int().min(1).max(100) }).parse(request.body); return await engine.society.configureBudget(body.tenantId, body.dailyTokenBudget, body.maxConcurrentTasks); });
app.get("/v1/society/budget", async (request) => { const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query); return await engine.society.budget(tenantId); });
app.get("/v1/society/tasks", async (request) => { const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query); return { tasks: await engine.society.tasks(tenantId) }; });
app.post("/v1/society/tasks", async (request, reply) => { const body = z.object({ tenantId: z.string().default("local"), rootSessionId: z.string(), title: z.string().min(1).max(300), objective: z.string().min(1).max(50_000), requiredCapabilityTags: z.array(z.string()).max(100).default([]), priority: z.enum(["critical","high","normal","low"]).default("normal"), maxTokens: z.number().int().min(100).max(10_000_000).default(100_000), deadline: z.string().datetime().optional() }).parse(request.body); return await reply.code(201).send(await engine.society.postTask({ tenantId: body.tenantId, rootSessionId: body.rootSessionId, title: body.title, objective: body.objective, requiredCapabilityTags: body.requiredCapabilityTags, priority: body.priority, maxTokens: body.maxTokens, ...(body.deadline ? { deadline: body.deadline } : {}) })); });
app.post("/v1/society/tasks/:taskId/bids", async (request, reply) => { const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params); const body = z.object({ tenantId: z.string().default("local"), roleId: z.string(), confidence: z.number().min(0).max(1), estimatedTokens: z.number().int().positive(), estimatedDurationMs: z.number().int().positive(), rationale: z.string().min(1).max(2000) }).parse(request.body); return await reply.code(201).send(await engine.society.bid({ taskId, ...body })); });
app.post("/v1/society/tasks/:taskId/award", async (request) => { const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params); const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.body ?? {}); return await engine.society.award(tenantId, taskId); });
app.post("/v1/society/tasks/:taskId/execute", async (request) => { const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params); const body = z.object({ tenantId: z.string().default("local"), sessionId: z.string() }).parse(request.body); const task = await engine.society.getTask(body.tenantId, taskId); if (task.rootSessionId !== body.sessionId) throw new Error("Society task root session mismatch."); return await executeSessionCapability(body.sessionId, "society.task.execute", { taskId }, "web", request.headers["x-idempotency-key"] as string | undefined); });
app.post("/v1/society/tasks/:taskId/outcome", async (request) => { const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params); const body = z.object({ tenantId: z.string().default("local"), success: z.boolean(), quality: z.number().min(0).max(1), actualTokens: z.number().int().nonnegative(), evidenceEventIds: z.array(z.string()).min(1).max(200) }).parse(request.body); return await engine.society.recordOutcome({ taskId, ...body }); });
app.post("/v1/society/tasks/:taskId/pause", async (request) => { const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params); const body = z.object({ tenantId: z.string().default("local"), reason: z.string().max(2000).optional() }).parse(request.body ?? {}); return await engine.society.pauseTask(body.tenantId, taskId, body.reason); });
app.post("/v1/society/tasks/:taskId/resume", async (request) => { const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params); const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.body ?? {}); return await engine.society.resumeTask(tenantId, taskId); });
app.post("/v1/society/tasks/:taskId/cancel", async (request) => { const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params); const body = z.object({ tenantId: z.string().default("local"), reason: z.string().max(2000).optional() }).parse(request.body ?? {}); return await engine.society.cancelTask(body.tenantId, taskId, body.reason); });
app.get("/v1/society/deliberations", async (request) => { const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query); return { deliberations: await engine.society.deliberations(tenantId) }; });
app.post("/v1/society/deliberations", async (request, reply) => { const body = z.object({ tenantId: z.string().default("local"), question: z.string().min(1).max(10_000), requiredRoleIds: z.array(z.string()).min(2).max(50), quorum: z.number().int().min(2).optional() }).parse(request.body); return await reply.code(201).send(await engine.society.createDeliberation({ tenantId: body.tenantId, question: body.question, requiredRoleIds: body.requiredRoleIds, ...(body.quorum !== undefined ? { quorum: body.quorum } : {}) })); });
app.post("/v1/society/deliberations/:id/perspectives", async (request, reply) => { const { id } = z.object({ id: z.string().uuid() }).parse(request.params); const body = z.object({ tenantId: z.string().default("local"), roleId: z.string(), recommendation: z.enum(["approve","reject","abstain"]), confidence: z.number().min(0).max(1), summary: z.string().min(1).max(10_000), evidenceEventIds: z.array(z.string()).max(200).default([]) }).parse(request.body); return await reply.code(201).send(await engine.society.submitPerspective({ deliberationId: id, ...body })); });
app.post("/v1/society/deliberations/:id/resolve", async (request) => { const { id } = z.object({ id: z.string().uuid() }).parse(request.params); const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.body ?? {}); return await engine.society.resolveDeliberation(tenantId, id); });
app.get("/v1/cognitive/objects", async (request) => { const q=z.object({tenantId:z.string().default("local"),attentionState:z.enum(["queued","focused","deferred"]).optional()}).parse(request.query); return {objects:await engine.cognitive.objects(q.tenantId,q.attentionState)}; });
app.post("/v1/cognitive/objects", async (request,reply) => { const b=z.object({tenantId:z.string().default("local"),sessionId:z.string().optional(),kind:z.enum(["observation","problem","hypothesis","insight","risk","opportunity","decision"]),title:z.string().min(1).max(500),content:z.string().min(1).max(100000),sourceType:z.enum(["user","agent","event","memory","system"]),sourceId:z.string().max(500).optional(),confidence:z.number().min(0).max(1),importance:z.number().min(0).max(1),urgency:z.number().min(0).max(1),impact:z.number().min(0).max(1),userRelevance:z.number().min(0).max(1),horizon:z.enum(["reactive","tactical","strategic"]),goalId:z.string().uuid().optional(),requestedTokens:z.number().int().min(100).optional(),requestedTimeMs:z.number().int().min(1000).optional(),tags:z.array(z.string()).max(100).optional(),relations:z.array(z.string()).max(200).optional()}).parse(request.body); return await reply.code(201).send(await engine.cognitive.createObject({tenantId:b.tenantId,kind:b.kind,title:b.title,content:b.content,sourceType:b.sourceType,confidence:b.confidence,importance:b.importance,urgency:b.urgency,impact:b.impact,userRelevance:b.userRelevance,horizon:b.horizon,...(b.sessionId?{sessionId:b.sessionId}:{}),...(b.sourceId?{sourceId:b.sourceId}:{}),...(b.goalId?{goalId:b.goalId}:{}),...(b.requestedTokens!==undefined?{requestedTokens:b.requestedTokens}:{}),...(b.requestedTimeMs!==undefined?{requestedTimeMs:b.requestedTimeMs}:{}),...(b.tags?{tags:b.tags}:{}),...(b.relations?{relations:b.relations}:{})})); });
app.post("/v1/cognitive/attention/allocate", async (request) => { const {tenantId}=z.object({tenantId:z.string().default("local")}).parse(request.body??{}); return await engine.cognitive.allocateAttention(tenantId); });
app.post("/v1/cognitive/objects/:id/complete", async (request) => { const {id}=z.object({id:z.string().uuid()}).parse(request.params); const b=z.object({tenantId:z.string().default("local"),outcome:z.enum(["active","solved","blocked"]),actualTokens:z.number().int().nonnegative()}).parse(request.body); return await engine.cognitive.completeFocus(b.tenantId,id,b.outcome,b.actualTokens); });
app.post("/v1/cognitive/objects/:id/iterations", async (request) => { const {id}=z.object({id:z.string().uuid()}).parse(request.params); const b=z.object({tenantId:z.string().default("local"),result:z.string().min(1).max(100000)}).parse(request.body); return await engine.cognitive.recordIteration(b.tenantId,id,b.result); });
app.get("/v1/cognitive/goals", async (request) => { const {tenantId}=z.object({tenantId:z.string().default("local")}).parse(request.query); return {goals:await engine.cognitive.goals(tenantId)}; });
app.post("/v1/cognitive/goals", async (request,reply) => { const b=z.object({tenantId:z.string().default("local"),title:z.string().min(1).max(300),objective:z.string().min(1).max(10000),class:z.enum(["P0","P1","P2","P3","P4"]),importance:z.number().min(0).max(1),urgency:z.number().min(0).max(1),userRelevance:z.number().min(0).max(1)}).parse(request.body); return await reply.code(201).send(await engine.cognitive.createGoal(b)); });
app.post("/v1/cognitive/goals/arbitrate", async (request) => { const {tenantId}=z.object({tenantId:z.string().default("local")}).parse(request.body??{}); return await engine.cognitive.arbitrateGoals(tenantId); });
app.get("/v1/cognitive/budget", async (request) => { const {tenantId}=z.object({tenantId:z.string().default("local")}).parse(request.query); return await engine.cognitive.budget(tenantId); });
app.post("/v1/cognitive/budget", async (request) => { const b=z.object({tenantId:z.string().default("local"),dailyTokenBudget:z.number().int().min(1000),maxFocusedObjects:z.number().int().min(1).max(100)}).parse(request.body); return await engine.cognitive.configureBudget(b.tenantId,b.dailyTokenBudget,b.maxFocusedObjects); });
app.get("/v1/cognitive/mode", async (request) => { const {tenantId}=z.object({tenantId:z.string().default("local")}).parse(request.query); return await engine.cognitive.mode(tenantId); });
app.post("/v1/cognitive/mode", async (request) => { const b=z.object({tenantId:z.string().default("local"),mode:z.enum(["reactive","research","development","reflection","dream","emergency"]),reason:z.string().min(1).max(1000)}).parse(request.body); return await engine.cognitive.transitionMode(b.tenantId,b.mode,b.reason); });
app.get("/v1/cognitive/arbitrations", async (request) => { const {tenantId}=z.object({tenantId:z.string().default("local")}).parse(request.query); return {arbitrations:await engine.cognitive.arbitrations(tenantId)}; });
// ---------------------------------------------------------------------------
/** Strip `undefined` values so optional REST fields satisfy the engine's exactOptionalPropertyTypes contracts. */
type AuroraDefined<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };
function auroraInput<T extends Record<string, unknown>>(value: T): AuroraDefined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as AuroraDefined<T>;
}
// Aurora Phase C — memory pyramid, relation graph, consolidation and anchors
// ---------------------------------------------------------------------------
const auroraTenant = z.object({ tenantId: z.string().default("local") });
const auroraUnit = z.number().min(0).max(1);
const memoryLayer = z.enum(["working","session","episodic","semantic","procedural","user","palace"]);
const memoryClaim = z.enum(["observation","inference","hypothesis","prediction"]);
app.get("/v1/memory-graph/memories", async (request) => { const q=auroraTenant.extend({layer:memoryLayer.optional(),claimType:memoryClaim.optional(),state:z.enum(["active","archived","superseded"]).optional(),tag:z.string().optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { memories: await engine.memoryGraph.list(q.tenantId,{...(q.layer?{layer:q.layer}:{}),...(q.claimType?{claimType:q.claimType}:{}),...(q.state?{state:q.state}:{}),...(q.tag?{tag:q.tag}:{}),...(q.limit?{limit:q.limit}:{})}) }; });
app.post("/v1/memory-graph/memories", async (request, reply) => { const b=auroraTenant.extend({layer:memoryLayer,claimType:memoryClaim,title:z.string().min(1).max(500),content:z.string().min(1).max(100_000),sourceType:z.enum(["user","agent","event","memory","system","external"]),sourceId:z.string().max(300).optional(),confidence:auroraUnit,importance:auroraUnit,emotionalImpact:auroraUnit.optional(),tags:z.array(z.string()).max(100).optional(),goalIds:z.array(z.string()).max(50).optional(),userId:z.string().max(200).optional(),validFrom:z.string().datetime().optional(),validTo:z.string().datetime().optional(),evidenceRefs:z.array(z.string()).max(200).optional(),relatedMemoryIds:z.array(z.string()).max(50).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.memoryGraph.remember(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/memory-graph/recall", async (request) => { const b=auroraTenant.extend({query:z.string().min(1).max(2000),strategy:z.enum(["semantic","graph","temporal","goal","user"]).optional(),layers:z.array(memoryLayer).max(7).optional(),claimTypes:z.array(memoryClaim).max(4).optional(),minConfidence:auroraUnit.optional(),goalId:z.string().optional(),userId:z.string().optional(),at:z.string().datetime().optional(),seedMemoryId:z.string().optional(),limit:z.number().int().min(1).max(100).optional()}).parse(request.body); const { tenantId, query, ...options } = b; return { results: await engine.memoryGraph.recall(tenantId, query, auroraInput(options)) }; });
app.post("/v1/memory-graph/relations", async (request, reply) => { const b=auroraTenant.extend({fromId:z.string(),toId:z.string(),type:z.enum(["relates","causes","supports","contradicts","part-of","derived-from","precedes"]),strength:auroraUnit.optional(),evidenceRefs:z.array(z.string()).max(200).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.memoryGraph.relate(auroraInput({ tenantId, ...rest }))); });
app.get("/v1/memory-graph/memories/:memoryId/neighborhood", async (request) => { const { memoryId } = z.object({ memoryId: z.string() }).parse(request.params); const q=auroraTenant.extend({depth:z.coerce.number().int().min(1).max(4).optional(),limit:z.coerce.number().int().min(1).max(500).optional()}).parse(request.query); return await engine.memoryGraph.neighborhood(q.tenantId, memoryId, q.depth ?? 1, q.limit ?? 50); });
app.post("/v1/memory-graph/consolidate", async (request) => { const b=auroraTenant.extend({layer:memoryLayer.optional(),similarityThreshold:auroraUnit.optional(),minClusterSize:z.number().int().min(2).max(100).optional(),maxClusters:z.number().int().min(1).max(200).optional()}).parse(request.body ?? {}); const { tenantId, ...options } = b; return await engine.memoryGraph.consolidate(tenantId, auroraInput(options)); });
app.post("/v1/memory-graph/contradictions", async (request) => { const b=auroraTenant.extend({similarityThreshold:auroraUnit.optional()}).parse(request.body ?? {}); return { contradictions: await engine.memoryGraph.detectContradictions(b.tenantId, b.similarityThreshold === undefined ? {} : { similarityThreshold: b.similarityThreshold }) }; });
app.get("/v1/memory-graph/health", async (request) => { const q=auroraTenant.parse(request.query); return await engine.memoryGraph.health(q.tenantId); });
app.post("/v1/memory-graph/sweep", async (request) => { const b=auroraTenant.parse(request.body ?? {}); return await engine.memoryGraph.sweep(b.tenantId); });
app.delete("/v1/memory-graph/memories/:memoryId", async (request) => { const { memoryId } = z.object({ memoryId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.memoryGraph.forget(q.tenantId, memoryId); });
app.get("/v1/memory-graph/anchors", async (request) => { const q=auroraTenant.extend({status:z.enum(["active","paused","resolved","abandoned"]).optional(),due:z.coerce.boolean().optional()}).parse(request.query); return { anchors: q.due ? await engine.memoryGraph.dueAnchors(q.tenantId) : await engine.memoryGraph.anchors(q.tenantId, q.status) }; });
app.post("/v1/memory-graph/anchors", async (request, reply) => { const b=auroraTenant.extend({title:z.string().min(1).max(300),question:z.string().min(1).max(5000),importance:auroraUnit,confidence:auroraUnit.optional(),nextStep:z.string().min(1).max(2000),reviewIntervalDays:z.number().int().min(1).max(365).optional(),memoryIds:z.array(z.string()).max(500).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.memoryGraph.createAnchor(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/memory-graph/anchors/:anchorId/progress", async (request) => { const { anchorId } = z.object({ anchorId: z.string() }).parse(request.params); const b=auroraTenant.extend({summary:z.string().min(1).max(10_000),confidence:auroraUnit,memoryIds:z.array(z.string()).max(200).optional(),nextStep:z.string().max(2000).optional(),status:z.enum(["active","paused","resolved","abandoned"]).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.memoryGraph.recordAnchorProgress(auroraInput({ tenantId, anchorId, ...rest })); });

// ---------------------------------------------------------------------------
// Aurora Phase D — world model and multi-world deliberation
// ---------------------------------------------------------------------------
const worldScope = z.enum(["personal","environment","digital","project","human","goal","general"]);
const worldSource = z.enum(["user","agent","event","memory","system","external"]);
app.get("/v1/world/entities", async (request) => { const q=auroraTenant.extend({scope:worldScope.optional(),type:z.string().optional()}).parse(request.query); return { entities: await engine.worldModel.entities(q.tenantId, { ...(q.scope?{scope:q.scope}:{}) }) }; });
app.post("/v1/world/entities", async (request, reply) => { const b=auroraTenant.extend({type:z.enum(["person","place","project","file","task","tool","website","model","organization","document","device","service","concept","goal"]),name:z.string().min(1).max(300),scope:worldScope.optional(),attributes:z.record(z.union([z.string(),z.number(),z.boolean()])).optional(),confidence:auroraUnit.optional(),importance:auroraUnit.optional(),tags:z.array(z.string()).max(100).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.worldModel.upsertEntity(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/world/states", async (request, reply) => { const b=auroraTenant.extend({entityId:z.string(),key:z.string().min(1).max(200),value:z.string().min(1).max(5000),claimType:memoryClaim.optional(),sourceType:worldSource,sourceId:z.string().max(300).optional(),confidence:auroraUnit,observedAt:z.string().datetime().optional(),validTo:z.string().datetime().optional(),evidenceRefs:z.array(z.string()).max(200).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.worldModel.recordState(auroraInput({ tenantId, ...rest }))); });
app.get("/v1/world/entities/:entityId/state", async (request) => { const { entityId } = z.object({ entityId: z.string() }).parse(request.params); const q=auroraTenant.extend({at:z.string().datetime().optional()}).parse(request.query); return { state: await engine.worldModel.stateAt(q.tenantId, entityId, q.at) }; });
app.get("/v1/world/entities/:entityId/temporal", async (request) => { const { entityId } = z.object({ entityId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.worldModel.temporalView(q.tenantId, entityId); });
app.get("/v1/world/entities/:entityId/reassess", async (request) => { const { entityId } = z.object({ entityId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.worldModel.reassess(q.tenantId, entityId); });
app.post("/v1/world/relations", async (request, reply) => { const b=auroraTenant.extend({fromEntityId:z.string(),toEntityId:z.string(),type:z.string().min(1).max(100),strength:auroraUnit.optional(),confidence:auroraUnit.optional(),validTo:z.string().datetime().optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.worldModel.relate(auroraInput({ tenantId, ...rest }))); });
app.get("/v1/world/events", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { events: await engine.worldModel.events(q.tenantId, q.limit ?? 100) }; });
app.post("/v1/world/events", async (request, reply) => { const b=auroraTenant.extend({entityIds:z.array(z.string()).max(50).optional(),summary:z.string().min(1).max(1000),detail:z.string().max(20_000).optional(),occurredAt:z.string().datetime().optional(),sourceType:worldSource,sourceId:z.string().max(300).optional(),confidence:auroraUnit,importance:auroraUnit.optional(),userRelevance:auroraUnit.optional(),tags:z.array(z.string()).max(100).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.worldModel.recordEvent(auroraInput({ tenantId, ...rest }))); });
app.get("/v1/world/causality", async (request) => { const q=auroraTenant.parse(request.query); return { links: await engine.worldModel.causalLinks(q.tenantId) }; });
app.post("/v1/world/causality", async (request, reply) => { const b=auroraTenant.extend({causeKind:z.enum(["event","state"]),causeRef:z.string(),effectKind:z.enum(["event","state"]),effectRef:z.string(),description:z.string().min(1).max(2000),strength:auroraUnit.optional(),confidence:auroraUnit.optional(),evidenceRefs:z.array(z.string()).max(200).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.worldModel.assertCausality(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/world/causality/:linkId/observations", async (request) => { const { linkId } = z.object({ linkId: z.string() }).parse(request.params); const b=auroraTenant.extend({confirmed:z.boolean(),evidenceRefs:z.array(z.string()).max(200).optional()}).parse(request.body); return await engine.worldModel.recordCausalObservation(b.tenantId, linkId, b.confirmed, b.evidenceRefs); });
app.get("/v1/world/predictions", async (request) => { const q=auroraTenant.extend({status:z.enum(["open","resolved","expired"]).optional()}).parse(request.query); return { predictions: await engine.worldModel.predictions(q.tenantId, q.status) }; });
app.post("/v1/world/predictions", async (request, reply) => { const b=auroraTenant.extend({statement:z.string().min(1).max(2000),probability:auroraUnit,horizonAt:z.string().datetime(),entityId:z.string().optional(),basisLinkIds:z.array(z.string()).max(100).optional(),basisStateIds:z.array(z.string()).max(100).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.worldModel.predict(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/world/predictions/:predictionId/resolve", async (request) => { const { predictionId } = z.object({ predictionId: z.string() }).parse(request.params); const b=auroraTenant.extend({outcome:z.boolean(),note:z.string().max(2000).optional()}).parse(request.body); return await engine.worldModel.resolvePrediction(b.tenantId, predictionId, b.outcome, b.note); });
app.get("/v1/world/calibration", async (request) => { const q=auroraTenant.parse(request.query); return await engine.worldModel.calibration(q.tenantId); });
app.get("/v1/world/consistency", async (request) => { const q=auroraTenant.parse(request.query); return { inconsistencies: await engine.worldModel.inconsistencies(q.tenantId) }; });
app.post("/v1/world/simulate", async (request) => { const b=auroraTenant.extend({premise:z.string().min(1).max(2000),startKind:z.enum(["event","state"]),startRef:z.string(),depth:z.number().int().min(1).max(8).optional(),mode:z.enum(["simulation","counterfactual"]).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.worldModel.simulate(auroraInput({ tenantId, ...rest })); });
app.get("/v1/world/scopes/:scope", async (request) => { const { scope } = z.object({ scope: worldScope }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.worldModel.scopeView(q.tenantId, scope); });
app.get("/v1/multiworld/perspectives", async (request) => { const q=auroraTenant.parse(request.query); return { perspectives: await engine.multiWorld.perspectives(q.tenantId) }; });
app.get("/v1/multiworld/analyses", async (request) => { const q=auroraTenant.extend({status:z.enum(["open","resolved"]).optional()}).parse(request.query); return { analyses: await engine.multiWorld.analyses(q.tenantId, q.status) }; });
app.post("/v1/multiworld/analyses", async (request, reply) => { const b=auroraTenant.extend({question:z.string().min(1).max(10_000),context:z.string().max(50_000).optional(),problemType:z.enum(["technical","economic","security","strategic","creative","user","research","operational","general"]).optional(),perspectiveIds:z.array(z.string()).max(50).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.multiWorld.createAnalysis(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/multiworld/analyses/:analysisId/views", async (request, reply) => { const { analysisId } = z.object({ analysisId: z.string() }).parse(request.params); const b=auroraTenant.extend({perspectiveId:z.string(),stance:z.enum(["support","oppose","neutral"]),confidence:auroraUnit,rationale:z.string().min(1).max(20_000),keyRisks:z.array(z.string()).max(20).optional(),keyOpportunities:z.array(z.string()).max(20).optional(),evidenceRefs:z.array(z.string()).max(200).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.multiWorld.submitView(auroraInput({ tenantId, analysisId, ...rest }))); });
app.post("/v1/multiworld/analyses/:analysisId/conflicts", async (request, reply) => { const { analysisId } = z.object({ analysisId: z.string() }).parse(request.params); const b=auroraTenant.extend({fromPerspectiveId:z.string(),targetPerspectiveId:z.string(),argument:z.string().min(1).max(10_000)}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.multiWorld.challenge(auroraInput({ tenantId, analysisId, ...rest }))); });
app.post("/v1/multiworld/analyses/:analysisId/scenarios", async (request, reply) => { const { analysisId } = z.object({ analysisId: z.string() }).parse(request.params); const b=auroraTenant.extend({name:z.string().min(1).max(200),description:z.string().min(1).max(20_000),probability:auroraUnit,parentScenarioId:z.string().optional(),endorsingPerspectiveIds:z.array(z.string()).max(50).optional(),indicators:z.array(z.string()).max(20).optional(),cost:auroraUnit.optional(),benefit:auroraUnit.optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.multiWorld.addScenario(auroraInput({ tenantId, analysisId, ...rest }))); });
app.get("/v1/multiworld/analyses/:analysisId/future-tree", async (request) => { const { analysisId } = z.object({ analysisId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return { branches: await engine.multiWorld.futureTree(q.tenantId, analysisId), outlook: await engine.multiWorld.futureTreeOutlook(q.tenantId, analysisId) }; });
app.post("/v1/multiworld/analyses/:analysisId/scenarios/:scenarioId/outcome", async (request) => { const p=z.object({ analysisId: z.string(), scenarioId: z.string() }).parse(request.params); const b=auroraTenant.extend({occurred:z.boolean()}).parse(request.body); return await engine.multiWorld.recordScenarioOutcome({ tenantId: b.tenantId, analysisId: p.analysisId, scenarioId: p.scenarioId, occurred: b.occurred }); });
app.post("/v1/multiworld/analyses/:analysisId/resolve", async (request) => { const { analysisId } = z.object({ analysisId: z.string() }).parse(request.params); const b=auroraTenant.extend({minimumViews:z.number().int().min(2).max(50).optional()}).parse(request.body ?? {}); return await engine.multiWorld.resolveAnalysis(b.tenantId, analysisId, b.minimumViews === undefined ? {} : { minimumViews: b.minimumViews }); });

// ---------------------------------------------------------------------------
// Aurora Phase E — proactive initiative and governed user model
// ---------------------------------------------------------------------------
app.get("/v1/initiative/watchers", async (request) => { const q=auroraTenant.parse(request.query); return { watchers: await engine.initiative.watchers(q.tenantId) }; });
app.post("/v1/initiative/watchers", async (request, reply) => { const b=auroraTenant.extend({kind:z.enum(["research","project","skill","risk","opportunity","pattern","schedule"]),name:z.string().min(1).max(200),target:z.string().min(1).max(1000),keywords:z.array(z.string()).max(100).optional(),intervalMinutes:z.number().int().min(1).max(43_200).optional(),mode:z.enum(["guardian","assistant"]).optional(),minWorthiness:auroraUnit.optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.initiative.registerWatcher(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/initiative/watchers/:watcherId/enabled", async (request) => { const { watcherId } = z.object({ watcherId: z.string() }).parse(request.params); const b=auroraTenant.extend({enabled:z.boolean()}).parse(request.body); return await engine.initiative.setWatcherEnabled(b.tenantId, watcherId, b.enabled); });
app.post("/v1/initiative/watchers/run", async (request) => { const b=auroraTenant.parse(request.body ?? {}); return await engine.initiative.runWatchers(b.tenantId); });
app.get("/v1/initiative/intake", async (request) => { const q=auroraTenant.extend({processed:z.coerce.boolean().optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { events: await engine.initiative.intakeEvents(q.tenantId, { ...(q.processed!==undefined?{processed:q.processed}:{}), ...(q.limit?{limit:q.limit}:{}) }) }; });
app.post("/v1/initiative/intake", async (request, reply) => { const b=auroraTenant.extend({source:z.enum(["memory","world-model","git","calendar","filesystem","weather","research","location","notification","cognitive","society","skill","system"]),summary:z.string().min(1).max(5000),occurredAt:z.string().datetime().optional(),tags:z.array(z.string()).max(100).optional(),entityRefs:z.array(z.string()).max(50).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.initiative.ingest(auroraInput({ tenantId, ...rest }))); });
app.get("/v1/initiative/initiatives", async (request) => { const q=auroraTenant.extend({state:z.enum(["candidate","queued","delivered","suppressed","digested","expired","dismissed"]).optional(),priority:z.enum(["P0","P1","P2","P3","P4"]).optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { initiatives: await engine.initiative.initiatives(q.tenantId, { ...(q.state?{state:q.state}:{}), ...(q.priority?{priority:q.priority}:{}), ...(q.limit?{limit:q.limit}:{}) }) }; });
app.post("/v1/initiative/initiatives", async (request, reply) => { const b=auroraTenant.extend({kind:z.enum(["opportunity","risk","reminder","insight","intervention","briefing"]),title:z.string().min(1).max(300),message:z.string().min(1).max(20_000),importance:auroraUnit,urgency:auroraUnit,impact:auroraUnit,confidence:auroraUnit,userRelevance:auroraUnit,goalAlignment:auroraUnit.optional(),mode:z.enum(["guardian","assistant"]).optional(),intakeEventIds:z.array(z.string()).max(100).optional(),evidenceRefs:z.array(z.string()).max(200).optional(),expiresAt:z.string().datetime().optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.initiative.propose(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/initiative/evaluate", async (request) => { const b=auroraTenant.parse(request.body ?? {}); return await engine.initiative.evaluate(b.tenantId); });
app.post("/v1/initiative/initiatives/:initiativeId/delivered", async (request) => { const { initiativeId } = z.object({ initiativeId: z.string() }).parse(request.params); const b=auroraTenant.extend({channel:z.string().min(1).max(100)}).parse(request.body); return await engine.initiative.markDelivered(b.tenantId, initiativeId, b.channel); });
app.post("/v1/initiative/initiatives/:initiativeId/feedback", async (request) => { const { initiativeId } = z.object({ initiativeId: z.string() }).parse(request.params); const b=auroraTenant.extend({useful:z.boolean(),actedOn:z.boolean(),note:z.string().max(2000).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.initiative.recordFeedback(auroraInput({ tenantId, initiativeId, ...rest })); });
app.post("/v1/initiative/initiatives/:initiativeId/escalate", async (request) => { const { initiativeId } = z.object({ initiativeId: z.string() }).parse(request.params); const b=auroraTenant.extend({reason:z.string().min(1).max(1000)}).parse(request.body); return await engine.initiative.escalate(b.tenantId, initiativeId, b.reason); });
app.post("/v1/initiative/initiatives/:initiativeId/dismiss", async (request) => { const { initiativeId } = z.object({ initiativeId: z.string() }).parse(request.params); const b=auroraTenant.extend({reason:z.string().min(1).max(500)}).parse(request.body); return await engine.initiative.dismiss(b.tenantId, initiativeId, b.reason); });
app.get("/v1/initiative/digests", async (request) => { const q=auroraTenant.extend({period:z.enum(["daily","weekly","monthly"]).optional()}).parse(request.query); return { digests: await engine.initiative.digests(q.tenantId, q.period) }; });
app.post("/v1/initiative/digests", async (request, reply) => { const b=auroraTenant.extend({period:z.enum(["daily","weekly","monthly"])}).parse(request.body); return await reply.code(201).send(await engine.initiative.buildDigest(b.tenantId, b.period)); });
app.get("/v1/initiative/budget", async (request) => { const q=auroraTenant.parse(request.query); return await engine.initiative.budget(q.tenantId); });
app.post("/v1/initiative/budget", async (request) => { const b=auroraTenant.extend({dailyImmediateLimit:z.number().int().min(0).max(100).optional(),dailyMessageLimit:z.number().int().min(0).max(200).optional(),minWorthinessP0:auroraUnit.optional(),minWorthinessP1:auroraUnit.optional(),minWorthinessP2:auroraUnit.optional(),quietHoursUtc:z.object({startHour:z.number().int().min(0).max(23),endHour:z.number().int().min(0).max(23)}).nullable().optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.initiative.configureBudget(auroraInput({ tenantId, ...rest })); });
const userCategory = z.enum(["identity-context","goal","motivation","decision-style","learning-style","strength","weakness","habit","productivity","energy","attention","frustration","communication","trust","interest","project","tooling"]);
app.get("/v1/user-model/:userId", async (request) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.userModel.summary(q.tenantId, userId); });
app.get("/v1/user-model/:userId/claims", async (request) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const q=auroraTenant.extend({category:userCategory.optional(),status:z.enum(["proposed","active","corrected","retracted","expired"]).optional()}).parse(request.query); return { claims: await engine.userModel.claims(q.tenantId, userId, { ...(q.category?{category:q.category}:{}), ...(q.status?{status:q.status}:{}) }) }; });
app.post("/v1/user-model/:userId/claims", async (request, reply) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const b=auroraTenant.extend({category:userCategory,key:z.string().min(1).max(200),value:z.string().min(1).max(5000),confidence:auroraUnit,source:z.enum(["user-stated","inferred","system"]),evidenceRefs:z.array(z.string()).max(200).optional(),expiresAt:z.string().datetime().optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.userModel.observeClaim(auroraInput({ tenantId, userId, ...rest }))); });
app.post("/v1/user-model/claims/:claimId/correct", async (request) => { const { claimId } = z.object({ claimId: z.string() }).parse(request.params); const b=auroraTenant.extend({correctedValue:z.string().min(1).max(5000),reason:z.string().min(1).max(2000),confidence:auroraUnit.optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.userModel.correctClaim(auroraInput({ tenantId, claimId, ...rest })); });
app.post("/v1/user-model/claims/:claimId/consent", async (request) => { const { claimId } = z.object({ claimId: z.string() }).parse(request.params); const b=auroraTenant.extend({consent:z.enum(["granted","pending","denied"])}).parse(request.body); return await engine.userModel.setConsent(b.tenantId, claimId, b.consent); });
app.post("/v1/user-model/claims/:claimId/retract", async (request) => { const { claimId } = z.object({ claimId: z.string() }).parse(request.params); const b=auroraTenant.extend({reason:z.string().min(1).max(2000)}).parse(request.body); return await engine.userModel.retractClaim(b.tenantId, claimId, b.reason); });
app.delete("/v1/user-model/:userId", async (request) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const q=auroraTenant.extend({category:userCategory.optional()}).parse(request.query); return await engine.userModel.forgetUser(q.tenantId, userId, q.category); });
app.get("/v1/user-model/:userId/goals", async (request) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const q=auroraTenant.extend({status:z.enum(["active","paused","achieved","abandoned"]).optional(),stalledDays:z.coerce.number().int().min(1).max(365).optional()}).parse(request.query); return { goals: q.stalledDays ? await engine.userModel.stalledGoals(q.tenantId, userId, q.stalledDays) : await engine.userModel.goals(q.tenantId, userId, q.status) }; });
app.post("/v1/user-model/:userId/goals", async (request, reply) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const b=auroraTenant.extend({horizon:z.enum(["long","medium","short"]),title:z.string().min(1).max(300),description:z.string().max(10_000).optional(),parentGoalId:z.string().optional(),importance:auroraUnit.optional(),goalId:z.string().optional(),progress:auroraUnit.optional(),status:z.enum(["active","paused","achieved","abandoned"]).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.userModel.upsertGoal(auroraInput({ tenantId, userId, ...rest }))); });
app.post("/v1/user-model/:userId/signals", async (request, reply) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const b=auroraTenant.extend({kind:z.enum(["activity","idle","message","commit","research","error","break"]),intensity:auroraUnit,at:z.string().datetime().optional(),note:z.string().max(1000).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.userModel.recordSignal(auroraInput({ tenantId, userId, ...rest }))); });
app.get("/v1/user-model/:userId/state", async (request) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.userModel.estimateState(q.tenantId, userId); });
app.get("/v1/user-model/:userId/frustration", async (request) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.userModel.frustrationRisk(q.tenantId, userId); });
app.get("/v1/user-model/:userId/timeline", async (request) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return { milestones: await engine.userModel.timeline(q.tenantId, userId) }; });
app.post("/v1/user-model/:userId/milestones", async (request, reply) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const b=auroraTenant.extend({kind:z.enum(["decision","success","failure","turning-point","start"]),title:z.string().min(1).max(300),summary:z.string().min(1).max(10_000),importance:auroraUnit.optional(),occurredAt:z.string().datetime().optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.userModel.addMilestone(auroraInput({ tenantId, userId, ...rest }))); });
app.post("/v1/user-model/:userId/advice", async (request, reply) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const b=auroraTenant.extend({summary:z.string().min(1).max(10_000),initiativeId:z.string().optional(),claimRefs:z.array(z.string()).max(100).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.userModel.recordAdvice(auroraInput({ tenantId, userId, ...rest }))); });
app.post("/v1/user-model/advice/:adviceId/outcome", async (request) => { const { adviceId } = z.object({ adviceId: z.string() }).parse(request.params); const b=auroraTenant.extend({followed:z.boolean(),helpful:z.boolean(),note:z.string().max(2000).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.userModel.recordAdviceOutcome(auroraInput({ tenantId, adviceId, ...rest })); });
app.post("/v1/user-model/:userId/alignment", async (request) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const b=auroraTenant.extend({proposal:z.string().min(1).max(10_000)}).parse(request.body); return await engine.userModel.alignmentCheck(b.tenantId, userId, b.proposal); });

// ---------------------------------------------------------------------------
// Aurora Phase F — skill/workflow evolution
// ---------------------------------------------------------------------------
const skillStage = z.enum(["blueprint","sandbox","test","beta","production","archived"]);
app.get("/v1/evolution/gaps", async (request) => { const q=auroraTenant.extend({status:z.enum(["open","candidate-created","resolved","dismissed"]).optional()}).parse(request.query); return { gaps: await engine.evolution.gaps(q.tenantId, q.status) }; });
app.post("/v1/evolution/gaps", async (request, reply) => { const b=auroraTenant.extend({kind:z.enum(["capability-gap","friction","bottleneck","error-pattern"]),description:z.string().min(1).max(5000),context:z.string().max(20_000).optional(),severity:auroraUnit.optional(),evidenceRefs:z.array(z.string()).max(200).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.evolution.observeGap(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/evolution/gaps/:gapId/dismiss", async (request) => { const { gapId } = z.object({ gapId: z.string() }).parse(request.params); const b=auroraTenant.extend({reason:z.string().min(1).max(1000)}).parse(request.body); return await engine.evolution.dismissGap(b.tenantId, gapId, b.reason); });
app.get("/v1/evolution/candidates", async (request) => { const q=auroraTenant.extend({stage:skillStage.optional()}).parse(request.query); return { candidates: await engine.evolution.candidates(q.tenantId, q.stage) }; });
app.post("/v1/evolution/candidates", async (request, reply) => { const b=auroraTenant.extend({name:z.string().min(1).max(200),purpose:z.string().min(1).max(10_000),gapId:z.string().optional(),inputs:z.array(z.string()).max(50).optional(),outputs:z.array(z.string()).max(50).optional(),tools:z.array(z.string()).max(50).optional(),risks:z.array(z.string()).max(50).optional(),tests:z.array(z.string()).max(50).optional(),compositeOfIds:z.array(z.string()).max(20).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.evolution.createBlueprint(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/evolution/candidates/:candidateId/evaluations", async (request, reply) => { const { candidateId } = z.object({ candidateId: z.string() }).parse(request.params); const b=auroraTenant.extend({suite:z.string().min(1).max(200),passed:z.number().int().min(0),failed:z.number().int().min(0),safetyFindings:z.number().int().min(0).max(10_000).optional(),averageLatencyMs:z.number().int().min(0).optional(),utility:auroraUnit.optional(),notes:z.string().max(5000).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.evolution.recordEvaluation(auroraInput({ tenantId, candidateId, ...rest }))); });
app.post("/v1/evolution/candidates/:candidateId/usage", async (request) => { const { candidateId } = z.object({ candidateId: z.string() }).parse(request.params); const b=auroraTenant.extend({success:z.boolean(),durationMs:z.number().int().min(0)}).parse(request.body); const { tenantId, ...rest } = b; return await engine.evolution.recordUsage(auroraInput({ tenantId, candidateId, ...rest })); });
app.post("/v1/evolution/candidates/:candidateId/baseline", async (request) => { const { candidateId } = z.object({ candidateId: z.string() }).parse(request.params); const b=auroraTenant.extend({suite:z.string().min(1).max(200),passRate:auroraUnit}).parse(request.body); return await engine.evolution.recordRegressionBaseline(b.tenantId, candidateId, b.suite, b.passRate); });
app.post("/v1/evolution/candidates/:candidateId/regression", async (request) => { const { candidateId } = z.object({ candidateId: z.string() }).parse(request.params); const b=auroraTenant.extend({results:z.array(z.object({suite:z.string().min(1).max(200),passRate:auroraUnit})).max(200)}).parse(request.body); return await engine.evolution.checkRegression(b.tenantId, candidateId, b.results); });
app.post("/v1/evolution/candidates/:candidateId/stage", async (request) => { const { candidateId } = z.object({ candidateId: z.string() }).parse(request.params); const b=auroraTenant.extend({to:skillStage,actor:z.string().min(1).max(200),reason:z.string().min(1).max(2000),approval:z.object({actor:z.string().min(1).max(200),reason:z.string().min(1).max(2000)}).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.evolution.advanceStage(auroraInput({ tenantId, candidateId, ...rest })); });
app.get("/v1/evolution/candidates/:candidateId/readiness", async (request) => { const { candidateId } = z.object({ candidateId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.evolution.stageReadiness(q.tenantId, candidateId); });
app.post("/v1/evolution/candidates/:candidateId/retire", async (request) => { const { candidateId } = z.object({ candidateId: z.string() }).parse(request.params); const b=auroraTenant.extend({reason:z.string().min(1).max(2000)}).parse(request.body); return await engine.evolution.retire({ tenantId: b.tenantId, candidateId, reason: b.reason }); });
app.post("/v1/evolution/retirement-sweep", async (request) => { const b=auroraTenant.extend({maxIdleDays:z.number().int().min(1).max(3650).optional(),minComposite:auroraUnit.optional()}).parse(request.body ?? {}); const { tenantId, ...rest } = b; return { retired: await engine.evolution.sweepRetirement(tenantId, auroraInput(rest)) }; });
app.get("/v1/evolution/composition", async (request) => { const q=auroraTenant.parse(request.query); return { nodes: await engine.evolution.compositionGraph(q.tenantId) }; });
app.get("/v1/evolution/workflows", async (request) => { const q=auroraTenant.parse(request.query); return { workflows: await engine.evolution.workflowBottlenecks(q.tenantId) }; });
app.post("/v1/evolution/workflows", async (request, reply) => { const b=auroraTenant.extend({name:z.string().min(1).max(200),steps:z.array(z.string()).min(1).max(100),averageDurationMs:z.number().int().min(0),successRate:auroraUnit,rationale:z.string().min(1).max(5000),bottleneckStep:z.string().max(300).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.evolution.recordWorkflowVersion(auroraInput({ tenantId, ...rest }))); });
app.get("/v1/evolution/journal", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(2000).optional()}).parse(request.query); return { entries: await engine.evolution.journalEntries(q.tenantId, q.limit ?? 200) }; });
app.get("/v1/evolution/index", async (request) => { const q=auroraTenant.parse(request.query); return await engine.evolution.evolutionIndex(q.tenantId); });

// ---------------------------------------------------------------------------
// Aurora Phase G — environment awareness and embodiment
// ---------------------------------------------------------------------------
const resourceKind = z.enum(["filesystem","terminal","ide","browser","git","database","api","device","cloud","calendar","channel","kernel","sandbox","mcp-server"]);
const zoneSchema = z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3),z.literal(4)]);
app.get("/v1/environment/resources", async (request) => { const q=auroraTenant.extend({kind:resourceKind.optional(),status:z.enum(["available","degraded","unavailable","retired"]).optional()}).parse(request.query); return { resources: await engine.environment.resources(q.tenantId, { ...(q.kind?{kind:q.kind}:{}), ...(q.status?{status:q.status}:{}) }) }; });
app.post("/v1/environment/resources", async (request, reply) => { const b=auroraTenant.extend({kind:resourceKind,name:z.string().min(1).max(200),locator:z.string().min(1).max(2000),zone:zoneSchema,capabilityIds:z.array(z.string()).max(100).optional(),requiresApproval:z.boolean().optional(),tags:z.array(z.string()).max(100).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.environment.registerResource(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/environment/resources/:resourceId/status", async (request) => { const { resourceId } = z.object({ resourceId: z.string() }).parse(request.params); const b=auroraTenant.extend({status:z.enum(["available","degraded","unavailable","retired"]),note:z.string().max(1000).optional()}).parse(request.body); return await engine.environment.setResourceStatus(b.tenantId, resourceId, b.status, b.note); });
app.get("/v1/environment/actions", async (request) => { const q=auroraTenant.extend({status:z.enum(["planned","approved","executing","completed","verified","failed","rolled-back"]).optional(),resourceId:z.string().optional(),unverified:z.coerce.boolean().optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { actions: q.unverified ? await engine.environment.unverifiedActions(q.tenantId) : await engine.environment.actions(q.tenantId, { ...(q.status?{status:q.status}:{}), ...(q.resourceId?{resourceId:q.resourceId}:{}), ...(q.limit?{limit:q.limit}:{}) }) }; });
app.post("/v1/environment/actions", async (request, reply) => { const b=auroraTenant.extend({resourceId:z.string(),goal:z.string().min(1).max(5000),plan:z.array(z.string()).min(1).max(50),action:z.string().min(1).max(2000),parameters:z.record(z.unknown()).optional(),expectedOutcome:z.string().min(1).max(5000),sessionId:z.string().optional(),rollbackPlan:z.string().max(5000).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.environment.planAction(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/environment/actions/:actionId/approve", async (request) => { const { actionId } = z.object({ actionId: z.string() }).parse(request.params); const b=auroraTenant.extend({actor:z.string().min(1).max(200),reason:z.string().min(1).max(2000)}).parse(request.body); const { tenantId, ...rest } = b; return await engine.environment.approveAction(auroraInput({ tenantId, actionId, ...rest })); });
app.post("/v1/environment/actions/:actionId/start", async (request) => { const { actionId } = z.object({ actionId: z.string() }).parse(request.params); const b=auroraTenant.parse(request.body ?? {}); return await engine.environment.startAction(b.tenantId, actionId); });
app.post("/v1/environment/actions/:actionId/complete", async (request) => { const { actionId } = z.object({ actionId: z.string() }).parse(request.params); const b=auroraTenant.extend({success:z.boolean(),summary:z.string().min(1).max(20_000),durationMs:z.number().int().min(0),unexpected:z.boolean().optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.environment.completeAction(auroraInput({ tenantId, actionId, ...rest })); });
app.post("/v1/environment/actions/:actionId/verify", async (request) => { const { actionId } = z.object({ actionId: z.string() }).parse(request.params); const b=auroraTenant.extend({method:z.string().min(1).max(500),passed:z.boolean(),evidenceRefs:z.array(z.string()).max(200).optional(),note:z.string().max(5000).optional(),memoryUpdateRefs:z.array(z.string()).max(100).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.environment.verifyAction(auroraInput({ tenantId, actionId, ...rest })); });
app.post("/v1/environment/actions/:actionId/rollback", async (request) => { const { actionId } = z.object({ actionId: z.string() }).parse(request.params); const b=auroraTenant.extend({reason:z.string().min(1).max(5000)}).parse(request.body); return await engine.environment.rollbackAction({ tenantId: b.tenantId, actionId, reason: b.reason }); });
app.get("/v1/environment/projects", async (request) => { const q=auroraTenant.extend({status:z.enum(["active","paused","archived"]).optional(),staleDays:z.coerce.number().int().min(1).max(365).optional()}).parse(request.query); return q.staleDays ? { projects: await engine.environment.staleProjects(q.tenantId, q.staleDays) } : { projects: await engine.environment.projects(q.tenantId, q.status) }; });
app.post("/v1/environment/projects", async (request, reply) => { const b=auroraTenant.extend({name:z.string().min(1).max(200),workspacePath:z.string().min(1).max(2000),repositoryRef:z.string().max(500).optional(),openTasks:z.number().int().min(0).max(100_000).optional(),risks:z.array(z.string()).max(50).optional(),progress:auroraUnit.optional(),status:z.enum(["active","paused","archived"]).optional(),lastActivityAt:z.string().datetime().optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.environment.upsertProject(auroraInput({ tenantId, ...rest }))); });
app.get("/v1/environment/habits", async (request) => { const q=auroraTenant.extend({scope:z.string().max(300).optional()}).parse(request.query); return { habits: await engine.environment.habits(q.tenantId, q.scope) }; });
app.post("/v1/environment/habits", async (request, reply) => { const b=auroraTenant.extend({scope:z.string().min(1).max(300),pattern:z.string().min(1).max(500),success:z.boolean()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.environment.recordHabit(auroraInput({ tenantId, ...rest }))); });
app.get("/v1/environment/inventory", async (request) => { const q=auroraTenant.parse(request.query); return await engine.environment.inventory(q.tenantId); });

// ---------------------------------------------------------------------------
// Aurora Phase A/B extensions — society bus, meta monitor and cognitive health
// ---------------------------------------------------------------------------
app.get("/v1/society/messages", async (request) => { const q=auroraTenant.extend({roleId:z.string(),unacknowledgedOnly:z.coerce.boolean().optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { messages: await engine.society.inbox(q.tenantId, q.roleId, { ...(q.unacknowledgedOnly!==undefined?{unacknowledgedOnly:q.unacknowledgedOnly}:{}), ...(q.limit?{limit:q.limit}:{}) }) }; });
app.post("/v1/society/messages", async (request, reply) => { const b=auroraTenant.extend({fromRoleId:z.string(),topic:z.string().min(1).max(200),body:z.string().min(1).max(20_000),audienceRoleIds:z.array(z.string()).max(50).optional(),taskId:z.string().optional(),deliberationId:z.string().optional(),importance:auroraUnit.optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.society.broadcast(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/society/messages/:messageId/acknowledge", async (request) => { const { messageId } = z.object({ messageId: z.string() }).parse(request.params); const b=auroraTenant.extend({roleId:z.string()}).parse(request.body); return await engine.society.acknowledgeMessage(b.tenantId, messageId, b.roleId); });
app.get("/v1/society/meta-monitor", async (request) => { const q=auroraTenant.extend({stalledAfterMs:z.coerce.number().int().min(60_000).optional(),idleAfterMs:z.coerce.number().int().min(60_000).optional()}).parse(request.query); return await engine.society.metaMonitor(q.tenantId, { ...(q.stalledAfterMs!==undefined?{stalledAfterMs:q.stalledAfterMs}:{}), ...(q.idleAfterMs!==undefined?{idleAfterMs:q.idleAfterMs}:{}) }); });
app.post("/v1/society/roles/retire-underperformers", async (request) => { const b=auroraTenant.extend({minAttempts:z.number().int().min(1).max(1000).optional(),maxFailureRate:auroraUnit.optional()}).parse(request.body ?? {}); const { tenantId, ...rest } = b; return { retired: await engine.society.retireUnderperformers(tenantId, auroraInput(rest)) }; });
app.get("/v1/cognitive/health", async (request) => { const q=auroraTenant.parse(request.query); return await engine.cognitive.health(q.tenantId); });
app.get("/v1/cognitive/curiosity", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(200).optional()}).parse(request.query); return { queue: await engine.cognitive.curiosityQueue(q.tenantId, q.limit ?? 20) }; });
app.get("/v1/cognitive/intake", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(5000).optional()}).parse(request.query); return { records: await engine.cognitive.intakeLog(q.tenantId, q.limit ?? 200) }; });
app.post("/v1/cognitive/intake", async (request, reply) => { const b=auroraTenant.extend({source:z.enum(["user","agent","event","memory","system","world-model","initiative","society","environment"]),title:z.string().min(1).max(500),content:z.string().min(1).max(100_000),sourceId:z.string().max(500).optional(),kind:z.enum(["observation","problem","hypothesis","insight","risk","opportunity","decision"]).optional(),goalId:z.string().optional(),confidence:auroraUnit.optional(),importance:auroraUnit.optional(),urgency:auroraUnit.optional(),impact:auroraUnit.optional(),userRelevance:auroraUnit.optional(),horizon:z.enum(["reactive","tactical","strategic"]).optional(),tags:z.array(z.string()).max(100).optional(),dailyLimit:z.number().int().min(1).max(100_000).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.cognitive.intake(auroraInput({ tenantId, ...rest }))); });
app.get("/v1/cognitive/allocation", async (request) => { const q=auroraTenant.parse(request.query); return { allocation: await engine.cognitive.allocationView(q.tenantId) }; });
app.post("/v1/cognitive/allocation", async (request) => { const b=auroraTenant.extend({buckets:z.array(z.object({name:z.string().min(1).max(100),share:auroraUnit})).min(1).max(20)}).parse(request.body); return await engine.cognitive.configureAllocation(b.tenantId, b.buckets); });
app.post("/v1/cognitive/attention/preempt", async (request) => { const b=auroraTenant.parse(request.body ?? {}); return await engine.cognitive.allocateAttention(b.tenantId, { preempt: true }); });
app.post("/v1/cognitive/objects/:id/interrupt", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); const b=auroraTenant.extend({reason:z.string().min(1).max(200)}).parse(request.body); return await engine.cognitive.interruptFocus(b.tenantId, id, b.reason); });
app.post("/v1/cognitive/reflections", async (request, reply) => { const b=auroraTenant.extend({kind:z.enum(["mini","deep","meta","dream"]),focusObjectIds:z.array(z.string()).max(50).optional(),note:z.string().max(5000).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.cognitive.scheduleReflection(auroraInput({ tenantId, ...rest }))); });

// ---------------------------------------------------------------------------
// Aurora core — constitution, continual harness, microagents, risk, ACOS
// ---------------------------------------------------------------------------
const harnessComponent = z.enum(["prompt-note","memory","skill-spec","subagent-spec"]);
const declaredRisk = z.enum(["pure","workspace_read","workspace_write","process","network","external_side_effect","privileged"]);
app.get("/v1/constitution/principles", async (request) => { const q=auroraTenant.extend({status:z.enum(["active","retired"]).optional()}).parse(request.query); return { principles: await engine.constitution.principles(q.tenantId, q.status) }; });
app.post("/v1/constitution/principles", async (request, reply) => { const b=auroraTenant.extend({code:z.string().min(1).max(20),title:z.string().min(1).max(200),statement:z.string().min(1).max(5000),category:z.enum(["safety","autonomy","privacy","evidence","resource","evolution","user","identity"]),severity:z.enum(["hard","soft"]).optional(),rationale:z.string().min(1).max(5000),approvedBy:z.string().min(1).max(200)}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.constitution.addPrinciple(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/constitution/principles/:principleId/amend", async (request) => { const { principleId } = z.object({ principleId: z.string() }).parse(request.params); const b=auroraTenant.extend({title:z.string().max(200).optional(),statement:z.string().max(5000).optional(),severity:z.enum(["hard","soft"]).optional(),approvedBy:z.string().min(1).max(200),reason:z.string().min(1).max(5000)}).parse(request.body); const { tenantId, ...rest } = b; return await engine.constitution.amendPrinciple(auroraInput({ tenantId, principleId, ...rest })); });
app.post("/v1/constitution/principles/:principleId/retire", async (request) => { const { principleId } = z.object({ principleId: z.string() }).parse(request.params); const b=auroraTenant.extend({approvedBy:z.string().min(1).max(200),reason:z.string().min(1).max(5000)}).parse(request.body); return await engine.constitution.retirePrinciple({ tenantId: b.tenantId, principleId, approvedBy: b.approvedBy, reason: b.reason }); });
app.get("/v1/constitution/identity", async (request) => { const q=auroraTenant.parse(request.query); return await engine.constitution.identity(q.tenantId); });
app.post("/v1/constitution/identity/mission", async (request) => { const b=auroraTenant.extend({mission:z.string().min(1).max(5000),approvedBy:z.string().min(1).max(200),reason:z.string().min(1).max(5000)}).parse(request.body); const { tenantId, ...rest } = b; return await engine.constitution.setMission(auroraInput({ tenantId, ...rest })); });
app.get("/v1/constitution/amendments", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(2000).optional()}).parse(request.query); return { amendments: await engine.constitution.amendments(q.tenantId, q.limit ?? 200) }; });
app.post("/v1/constitution/check", async (request) => { const b=auroraTenant.extend({actor:z.string().min(1).max(200),summary:z.string().min(1).max(5000),attributes:z.record(z.unknown())}).parse(request.body); return await engine.constitution.check({ tenantId: b.tenantId, actor: b.actor, summary: b.summary, attributes: auroraInput(b.attributes as Record<string, never>) }); });
app.get("/v1/constitution/decisions", async (request) => { const q=auroraTenant.extend({verdict:z.enum(["allow","review","deny"]).optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { decisions: await engine.constitution.decisions(q.tenantId, { ...(q.verdict?{verdict:q.verdict}:{}), ...(q.limit?{limit:q.limit}:{}) }) }; });
app.get("/v1/constitution/compliance", async (request) => { const q=auroraTenant.extend({windowDays:z.coerce.number().int().min(1).max(3650).optional()}).parse(request.query); return await engine.constitution.compliance(q.tenantId, q.windowDays ?? 30); });

app.get("/v1/harness/entries", async (request) => { const q=auroraTenant.extend({sessionId:z.string().optional(),component:harnessComponent.optional(),enabledOnly:z.coerce.boolean().optional(),scope:z.enum(["session","tenant"]).optional()}).parse(request.query); return { entries: await engine.harness.entries(q.tenantId, auroraInput({ sessionId: q.sessionId, component: q.component, enabledOnly: q.enabledOnly, scope: q.scope })) }; });
app.post("/v1/harness/entries", async (request, reply) => { const b=auroraTenant.extend({scope:z.enum(["session","tenant"]).optional(),sessionId:z.string().optional(),component:harnessComponent,key:z.string().min(1).max(200),title:z.string().min(1).max(300),body:z.string().min(1).max(20_000),tags:z.array(z.string()).max(100).optional(),priority:z.number().int().min(0).max(100).optional(),origin:z.enum(["user","agent","refinement","system"]).optional(),evidenceRefs:z.array(z.string()).max(200).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.harness.upsert(auroraInput({ tenantId, ...rest }))); });
app.delete("/v1/harness/entries/:entryId", async (request) => { const { entryId } = z.object({ entryId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.harness.remove(q.tenantId, entryId); });
app.post("/v1/harness/refinements", async (request, reply) => { const b=auroraTenant.extend({scope:z.enum(["session","tenant"]).optional(),sessionId:z.string().optional(),trigger:z.string().min(1).max(2000),rationale:z.string().min(1).max(10_000),evidenceRefs:z.array(z.string()).max(200).optional(),operations:z.array(z.object({operation:z.enum(["create","update","delete","enable","disable"]),component:harnessComponent,key:z.string().min(1).max(200),title:z.string().max(300).optional(),body:z.string().max(20_000).optional(),tags:z.array(z.string()).max(100).optional(),priority:z.number().int().min(0).max(100).optional(),evidenceRefs:z.array(z.string()).max(200).optional()})).min(1).max(8)}).parse(request.body); const { tenantId, operations, ...rest } = b; return await reply.code(201).send(await engine.harness.refine(auroraInput({ tenantId, operations: operations.map((item) => auroraInput(item)), ...rest }))); });
app.get("/v1/harness/refinements", async (request) => { const q=auroraTenant.extend({sessionId:z.string().optional(),status:z.enum(["applied","rolled-back"]).optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { refinements: await engine.harness.refinements(q.tenantId, auroraInput({ sessionId: q.sessionId, status: q.status, limit: q.limit })) }; });
app.post("/v1/harness/refinements/:refinementId/rollback", async (request) => { const { refinementId } = z.object({ refinementId: z.string() }).parse(request.params); const b=auroraTenant.parse(request.body ?? {}); return await engine.harness.rollback(b.tenantId, refinementId); });
app.post("/v1/harness/refinements/:refinementId/outcome", async (request) => { const { refinementId } = z.object({ refinementId: z.string() }).parse(request.params); const b=auroraTenant.extend({helpful:z.boolean(),note:z.string().min(1).max(2000)}).parse(request.body); return await engine.harness.recordRefinementOutcome(b.tenantId, refinementId, b.helpful, b.note); });
app.post("/v1/harness/projection", async (request) => { const b=auroraTenant.extend({sessionId:z.string().optional(),characterBudget:z.number().int().min(200).max(100_000).optional(),components:z.array(harnessComponent).max(4).optional()}).parse(request.body ?? {}); const { tenantId, ...rest } = b; return await engine.harness.project(auroraInput({ tenantId, ...rest })); });
app.post("/v1/harness/prune", async (request) => { const b=auroraTenant.extend({minUseCount:z.number().int().min(0).max(1000).optional(),maxIdleDays:z.number().int().min(1).max(3650).optional(),minEffectiveness:auroraUnit.optional()}).parse(request.body ?? {}); const { tenantId, ...rest } = b; return { pruned: await engine.harness.prune(tenantId, auroraInput(rest)) }; });

app.get("/v1/microagents", async (request) => { const q=auroraTenant.extend({activation:z.enum(["always","keyword","glob","manual"]).optional(),enabledOnly:z.coerce.boolean().optional(),quarantinedOnly:z.coerce.boolean().optional()}).parse(request.query); return { microagents: await engine.microagents.list(q.tenantId, auroraInput({ activation: q.activation, enabledOnly: q.enabledOnly, quarantinedOnly: q.quarantinedOnly })) }; });
app.post("/v1/microagents", async (request, reply) => { const b=auroraTenant.extend({name:z.string().min(2).max(120),body:z.string().min(1).max(50_000),activation:z.enum(["always","keyword","glob","manual"]).optional(),triggers:z.array(z.string()).max(100).optional(),globs:z.array(z.string()).max(50).optional(),summary:z.string().max(1000).optional(),priority:z.number().int().min(0).max(100).optional(),source:z.enum(["user","repository","skill","learned"]).optional(),sourceRef:z.string().max(500).optional(),tags:z.array(z.string()).max(100).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.microagents.register(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/microagents/recall", async (request) => { const b=auroraTenant.extend({query:z.string().max(20_000).optional(),touchedPaths:z.array(z.string()).max(200).optional(),requestedNames:z.array(z.string()).max(50).optional(),characterBudget:z.number().int().min(50).max(100_000).optional()}).parse(request.body ?? {}); const { tenantId, ...rest } = b; return await engine.microagents.recall(auroraInput({ tenantId, ...rest })); });
app.post("/v1/microagents/:microagentId/approve", async (request) => { const { microagentId } = z.object({ microagentId: z.string() }).parse(request.params); const b=auroraTenant.extend({reviewer:z.string().min(1).max(200)}).parse(request.body); return await engine.microagents.approveQuarantined(b.tenantId, microagentId, b.reviewer); });
app.post("/v1/microagents/:microagentId/enabled", async (request) => { const { microagentId } = z.object({ microagentId: z.string() }).parse(request.params); const b=auroraTenant.extend({enabled:z.boolean()}).parse(request.body); return await engine.microagents.setEnabled(b.tenantId, microagentId, b.enabled); });
app.post("/v1/microagents/:microagentId/feedback", async (request) => { const { microagentId } = z.object({ microagentId: z.string() }).parse(request.params); const b=auroraTenant.extend({helpful:z.boolean()}).parse(request.body); return await engine.microagents.recordFeedback(b.tenantId, microagentId, b.helpful); });
app.delete("/v1/microagents/:microagentId", async (request) => { const { microagentId } = z.object({ microagentId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.microagents.remove(q.tenantId, microagentId); });

app.get("/v1/risk/rules", async (request) => { const q=auroraTenant.parse(request.query); return { rules: await engine.riskAnalyzer.rules(q.tenantId) }; });
app.post("/v1/risk/rules", async (request, reply) => { const b=auroraTenant.extend({code:z.string().min(2).max(60),description:z.string().min(1).max(1000),level:z.enum(["low","medium","high","critical"]),pattern:z.string().min(1).max(2000),appliesToCapabilityIds:z.array(z.string()).max(100).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.riskAnalyzer.addRule(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/risk/rules/:ruleId/enabled", async (request) => { const { ruleId } = z.object({ ruleId: z.string() }).parse(request.params); const b=auroraTenant.extend({enabled:z.boolean()}).parse(request.body); return await engine.riskAnalyzer.setRuleEnabled(b.tenantId, ruleId, b.enabled); });
app.post("/v1/risk/assess", async (request) => { const b=auroraTenant.extend({capabilityId:z.string().min(1).max(200),declaredRisk,args:z.record(z.unknown()).optional(),sessionId:z.string().optional(),record:z.boolean().optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.riskAnalyzer.assess(auroraInput({ tenantId, ...rest })); });
app.get("/v1/risk/assessments", async (request) => { const q=auroraTenant.extend({level:z.enum(["low","medium","high","critical"]).optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { assessments: await engine.riskAnalyzer.assessments(q.tenantId, auroraInput({ level: q.level, limit: q.limit })) }; });
app.get("/v1/risk/policy", async (request) => { const q=auroraTenant.parse(request.query); return await engine.riskAnalyzer.policy(q.tenantId); });
app.post("/v1/risk/policy", async (request) => { const b=auroraTenant.extend({mode:z.enum(["never","critical","high","medium","all"]),autoDenyCritical:z.boolean().optional()}).parse(request.body); return await engine.riskAnalyzer.setPolicy(b.tenantId, b.mode, b.autoDenyCritical); });
app.get("/v1/risk/posture", async (request) => { const q=auroraTenant.extend({windowDays:z.coerce.number().int().min(1).max(365).optional()}).parse(request.query); return await engine.riskAnalyzer.posture(q.tenantId, q.windowDays ?? 7); });

app.get("/v1/sessions/:sessionId/stuck", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const q=z.object({windowSize:z.coerce.number().int().min(4).max(500).optional(),repeatThreshold:z.coerce.number().int().min(2).max(50).optional(),monologueThreshold:z.coerce.number().int().min(2).max(50).optional()}).parse(request.query); return await engine.stuckDetector.analyze(sessionId, auroraInput(q)); });

app.post("/v1/acos/cycles", async (request, reply) => { const b=auroraTenant.extend({mode:z.enum(["full","maintenance","reflection","dream","emergency"]).optional(),userId:z.string().max(200).optional(),preempt:z.boolean().optional(),maxInsights:z.number().int().min(1).max(20).optional()}).parse(request.body ?? {}); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.acos.tick(tenantId, auroraInput(rest))); });
app.get("/v1/acos/cycles", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { cycles: await engine.acos.cycles(q.tenantId, q.limit ?? 20) }; });
app.get("/v1/acos/status", async (request) => { const q=auroraTenant.extend({userId:z.string().max(200).optional()}).parse(request.query); return await engine.acos.status(q.tenantId, q.userId); });
app.get("/v1/acos/journal", async (request) => { const q=auroraTenant.extend({kind:z.enum(["cycle","insight","decision","reflection","anomaly","note"]).optional(),limit:z.coerce.number().int().min(1).max(2000).optional()}).parse(request.query); return { entries: await engine.acos.journal(q.tenantId, auroraInput({ kind: q.kind, limit: q.limit })) }; });
app.post("/v1/acos/journal", async (request, reply) => { const b=auroraTenant.extend({kind:z.enum(["cycle","insight","decision","reflection","anomaly","note"]).optional(),title:z.string().min(1).max(300),body:z.string().min(1).max(20_000),refs:z.array(z.string()).max(100).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.acos.note(auroraInput({ tenantId, ...rest }))); });
app.post("/v1/memory-graph/insights", async (request) => { const b=auroraTenant.extend({minSharedTags:z.number().int().min(1).max(20).optional(),minImportance:auroraUnit.optional(),limit:z.number().int().min(1).max(100).optional()}).parse(request.body ?? {}); const { tenantId, ...rest } = b; return { candidates: await engine.memoryGraph.proposeInsights(tenantId, auroraInput(rest)) }; });
app.post("/v1/memory-graph/insights/materialize", async (request, reply) => { const b=auroraTenant.extend({leftId:z.string(),rightId:z.string(),title:z.string().min(1).max(300),content:z.string().min(1).max(100_000),confidence:auroraUnit.optional(),importance:auroraUnit.optional(),tags:z.array(z.string()).max(100).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.memoryGraph.materializeInsight(auroraInput({ tenantId, ...rest }))); });

// ---------------------------------------------------------------------------
// Aurora reasoning — decisions, plans, experience distillation, autopilot, provenance
// ---------------------------------------------------------------------------
const planStepSchema = z.object({ key: z.string().min(1).max(120), title: z.string().min(1).max(300), detail: z.string().max(20_000).optional(), dependsOn: z.array(z.string()).max(50).optional(), estimateMinutes: z.number().int().min(0).max(100_000).optional(), estimateTokens: z.number().int().min(0).max(100_000_000).optional(), riskLevel: auroraUnit.optional(), verification: z.string().max(2000).optional(), assignedRoleId: z.string().max(200).optional() });
const planStepStatus = z.enum(["pending","ready","in-progress","blocked","done","skipped","failed"]);
app.get("/v1/decisions", async (request) => { const q=auroraTenant.extend({status:z.enum(["draft","open","decided","executed","reviewed","abandoned"]).optional(),due:z.coerce.boolean().optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return q.due ? { decisions: await engine.decisions.dueForReview(q.tenantId) } : { decisions: await engine.decisions.list(q.tenantId, auroraInput({ status: q.status, limit: q.limit })) }; });
app.post("/v1/decisions", async (request, reply) => { const b=auroraTenant.extend({title:z.string().min(1).max(300),question:z.string().min(1).max(10_000),context:z.string().max(50_000).optional(),sessionId:z.string().optional(),reversibility:z.enum(["reversible","costly","irreversible"]).optional(),criteria:z.array(z.object({name:z.string().min(1).max(120),weight:auroraUnit,direction:z.enum(["maximize","minimize"]).optional(),description:z.string().max(1000).optional()})).min(1).max(20),goalIds:z.array(z.string()).max(50).optional(),analysisId:z.string().optional(),evidenceRefs:z.array(z.string()).max(200).optional()}).parse(request.body); const { tenantId, criteria, ...rest } = b; return await reply.code(201).send(await engine.decisions.open(auroraInput({ tenantId, criteria: criteria.map((item) => auroraInput(item)), ...rest }))); });
app.get("/v1/decisions/:decisionId", async (request) => { const { decisionId } = z.object({ decisionId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.decisions.get(q.tenantId, decisionId); });
app.post("/v1/decisions/:decisionId/options", async (request, reply) => { const { decisionId } = z.object({ decisionId: z.string() }).parse(request.params); const b=auroraTenant.extend({name:z.string().min(1).max(200),description:z.string().max(20_000).optional(),scores:z.record(auroraUnit),risks:z.array(z.string()).max(20).optional(),cost:z.object({tokens:z.number().int().min(0).optional(),hours:z.number().min(0).optional(),money:z.number().min(0).optional()}).optional(),evidenceRefs:z.array(z.string()).max(200).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.decisions.addOption(auroraInput({ tenantId, decisionId, ...rest }))); });
app.post("/v1/decisions/:decisionId/dissent", async (request, reply) => { const { decisionId } = z.object({ decisionId: z.string() }).parse(request.params); const b=auroraTenant.extend({source:z.string().min(1).max(200),concern:z.string().min(1).max(5000)}).parse(request.body); return await reply.code(201).send(await engine.decisions.recordDissent({ tenantId: b.tenantId, decisionId, source: b.source, concern: b.concern })); });
app.post("/v1/decisions/:decisionId/decide", async (request) => { const { decisionId } = z.object({ decisionId: z.string() }).parse(request.params); const b=auroraTenant.extend({rationale:z.string().min(1).max(20_000),expectedOutcome:z.string().min(1).max(5000),chosenOptionId:z.string().optional(),overrideReason:z.string().max(5000).optional(),reviewInDays:z.number().int().min(1).max(3650).optional(),constitutionVerdictId:z.string().optional(),constitutionVerdict:z.enum(["allow","review","deny"]).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.decisions.decide(auroraInput({ tenantId, decisionId, ...rest })); });
app.post("/v1/decisions/:decisionId/outcome", async (request) => { const { decisionId } = z.object({ decisionId: z.string() }).parse(request.params); const b=auroraTenant.extend({succeeded:z.boolean(),observedValue:auroraUnit.optional(),note:z.string().min(1).max(10_000),evidenceRefs:z.array(z.string()).max(200).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.decisions.recordOutcome(auroraInput({ tenantId, decisionId, ...rest })); });
app.get("/v1/decisions-calibration", async (request) => { const q=auroraTenant.parse(request.query); return await engine.decisions.calibration(q.tenantId); });

app.get("/v1/plans", async (request) => { const q=auroraTenant.extend({status:z.enum(["draft","active","blocked","completed","abandoned","superseded"]).optional(),goalId:z.string().optional(),stalledDays:z.coerce.number().int().min(1).max(365).optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return q.stalledDays ? { stalled: await engine.planning.stalled(q.tenantId, q.stalledDays) } : { plans: await engine.planning.list(q.tenantId, auroraInput({ status: q.status, goalId: q.goalId, limit: q.limit })) }; });
app.post("/v1/plans", async (request, reply) => { const b=auroraTenant.extend({title:z.string().min(1).max(300),objective:z.string().min(1).max(20_000),horizon:z.enum(["reactive","tactical","strategic"]).optional(),sessionId:z.string().optional(),goalId:z.string().optional(),decisionId:z.string().optional(),tags:z.array(z.string()).max(100).optional(),steps:z.array(planStepSchema).min(1).max(200)}).parse(request.body); const { tenantId, steps, ...rest } = b; return await reply.code(201).send(await engine.planning.create(auroraInput({ tenantId, steps: steps.map((item) => auroraInput(item)), ...rest }))); });
app.get("/v1/plans/:planId", async (request) => { const { planId } = z.object({ planId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.planning.get(q.tenantId, planId); });
app.get("/v1/plans/:planId/progress", async (request) => { const { planId } = z.object({ planId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.planning.progress(q.tenantId, planId); });
app.post("/v1/plans/:planId/revise", async (request) => { const { planId } = z.object({ planId: z.string() }).parse(request.params); const b=auroraTenant.extend({reason:z.string().min(1).max(5000),trigger:z.enum(["manual","step-failed","blocked","scope-change","budget","review"]).optional(),steps:z.array(planStepSchema.extend({status:planStepStatus.optional()})).min(1).max(200)}).parse(request.body); const { tenantId, steps, ...rest } = b; return await engine.planning.revise(auroraInput({ tenantId, planId, steps: steps.map((item) => auroraInput(item)), ...rest })); });
app.post("/v1/plans/:planId/steps/:stepKey", async (request) => { const p=z.object({ planId: z.string(), stepKey: z.string() }).parse(request.params); const b=auroraTenant.extend({status:planStepStatus,note:z.string().max(5000).optional(),actualMinutes:z.number().int().min(0).max(100_000).optional(),evidenceRefs:z.array(z.string()).max(200).optional(),taskId:z.string().max(200).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.planning.updateStep(auroraInput({ tenantId, planId: p.planId, stepKey: p.stepKey, ...rest })); });
app.post("/v1/plans/:planId/abandon", async (request) => { const { planId } = z.object({ planId: z.string() }).parse(request.params); const b=auroraTenant.extend({reason:z.string().min(1).max(5000)}).parse(request.body); return await engine.planning.abandon(b.tenantId, planId, b.reason); });

app.post("/v1/experience/distill", async (request, reply) => { const b=auroraTenant.extend({sessionId:z.string(),objective:z.string().max(5000).optional(),maxEvents:z.number().int().min(10).max(5000).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.distiller.distill(auroraInput({ tenantId, ...rest }))); });
app.get("/v1/experience/proposals", async (request) => { const q=auroraTenant.extend({status:z.enum(["proposed","applied","rejected","duplicate"]).optional(),kind:z.enum(["harness-memory","microagent","skill-blueprint","workflow"]).optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { proposals: await engine.distiller.proposals(q.tenantId, auroraInput({ status: q.status, kind: q.kind, limit: q.limit })) }; });
app.post("/v1/experience/proposals/:proposalId/apply", async (request) => { const { proposalId } = z.object({ proposalId: z.string() }).parse(request.params); const b=auroraTenant.extend({actor:z.string().min(1).max(200)}).parse(request.body); return await engine.distiller.apply({ tenantId: b.tenantId, proposalId, actor: b.actor }); });
app.post("/v1/experience/proposals/:proposalId/reject", async (request) => { const { proposalId } = z.object({ proposalId: z.string() }).parse(request.params); const b=auroraTenant.extend({reason:z.string().min(1).max(2000)}).parse(request.body); return await engine.distiller.reject(b.tenantId, proposalId, b.reason); });

app.get("/v1/autopilot", async (request) => { const q=auroraTenant.parse(request.query); return await engine.autopilot.health(q.tenantId); });
app.post("/v1/autopilot", async (request) => { const b=auroraTenant.extend({enabled:z.boolean().optional(),maxRunsPerDay:z.number().int().min(0).max(5000).optional(),quietHoursUtc:z.object({startHour:z.number().int().min(0).max(23),endHour:z.number().int().min(0).max(23)}).nullable().optional(),cadences:z.array(z.object({kind:z.enum(["pulse","maintenance","reflection","dream","daily-briefing","weekly-review","monthly-strategy"]),enabled:z.boolean().optional(),everyMinutes:z.number().int().min(5).max(129_600).optional()})).max(7).optional()}).parse(request.body); const { tenantId, cadences, ...rest } = b; return await engine.autopilot.configure(auroraInput({ tenantId, ...(cadences ? { cadences: cadences.map((item) => auroraInput(item)) } : {}), ...rest })); });
app.post("/v1/autopilot/run-due", async (request) => { const b=auroraTenant.parse(request.body ?? {}); return { runs: await engine.autopilot.runDue(b.tenantId) }; });
app.get("/v1/autopilot/runs", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { runs: await engine.autopilot.runs(q.tenantId, q.limit ?? 50) }; });

// Fleet supervision is cross-tenant, so it is system-admin only: tenant agents can only reach their
// own membership through the tenant-scoped fleet.* capabilities.
app.get("/v1/aurora/fleet", async () => await engine.auroraFleet.status());
app.get("/v1/aurora/fleet/members", async () => ({ members: await engine.auroraFleet.members() }));
app.post("/v1/aurora/fleet/members", async (request, reply) => { const b=z.object({tenantId:z.string().min(1).max(200),enabled:z.boolean().optional(),priority:z.number().int().min(1).max(5).optional(),maxRunsPerSweep:z.number().int().min(1).max(50).optional(),note:z.string().max(500).optional()}).parse(request.body); return await reply.code(201).send(await engine.auroraFleet.enroll(auroraInput(b))); });
app.post("/v1/aurora/fleet/members/:tenantId/resume", async (request) => { const { tenantId } = z.object({ tenantId: z.string().min(1).max(200) }).parse(request.params); return await engine.auroraFleet.resume(tenantId); });
app.delete("/v1/aurora/fleet/members/:tenantId", async (request) => { const { tenantId } = z.object({ tenantId: z.string().min(1).max(200) }).parse(request.params); return await engine.auroraFleet.withdraw(tenantId); });
app.get("/v1/aurora/fleet/members/:tenantId", async (request) => { const { tenantId } = z.object({ tenantId: z.string().min(1).max(200) }).parse(request.params); return await engine.auroraFleet.tenantStatus(tenantId); });
app.post("/v1/aurora/fleet/sweep", async (request) => { const b=z.object({limit:z.number().int().min(1).max(500).optional(),tenantId:z.string().min(1).max(200).optional()}).parse(request.body ?? {}); return await engine.auroraFleet.sweep(auroraInput(b)); });
app.get("/v1/aurora/fleet/sweeps", async (request) => { const q=z.object({limit:z.coerce.number().int().min(1).max(500).optional()}).parse(request.query); return { sweeps: await engine.auroraFleet.sweeps(q.limit ?? 20) }; });

// Aurora execution bridge — plan steps delegated to the society, and society outcomes reconciled back
app.get("/v1/plans/:planId/delegations", async (request) => { const { planId } = z.object({ planId: z.string() }).parse(request.params); const q=auroraTenant.extend({openOnly:z.coerce.boolean().optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { links: await engine.delegation.links(q.tenantId, auroraInput({ planId, openOnly: q.openOnly, limit: q.limit })) }; });
app.get("/v1/plans/:planId/delegation-report", async (request) => { const { planId } = z.object({ planId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.delegation.report(q.tenantId, planId); });
app.post("/v1/plans/:planId/delegate", async (request, reply) => { const { planId } = z.object({ planId: z.string() }).parse(request.params); const b=auroraTenant.extend({rootSessionId:z.string().max(200).optional(),stepKeys:z.array(z.string().min(1).max(120)).max(25).optional(),max:z.number().int().min(1).max(25).optional(),priority:z.enum(["critical","high","normal","low"]).optional(),capabilityTags:z.array(z.string()).max(20).optional(),nominate:z.boolean().optional(),award:z.boolean().optional(),activate:z.boolean().optional()}).parse(request.body ?? {}); const { tenantId, ...rest } = b; return await reply.code(201).send(await engine.delegation.delegate(auroraInput({ tenantId, planId, ...rest }))); });
app.post("/v1/plans/:planId/delegations/sync", async (request) => { const { planId } = z.object({ planId: z.string() }).parse(request.params); const b=auroraTenant.extend({limit:z.number().int().min(1).max(2000).optional()}).parse(request.body ?? {}); return await engine.delegation.sync(auroraInput({ tenantId: b.tenantId, planId, limit: b.limit })); });
app.get("/v1/delegations", async (request) => { const q=auroraTenant.extend({openOnly:z.coerce.boolean().optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { links: await engine.delegation.links(q.tenantId, auroraInput({ openOnly: q.openOnly, limit: q.limit })) }; });
app.post("/v1/delegations/sync", async (request) => { const b=auroraTenant.extend({limit:z.number().int().min(1).max(2000).optional()}).parse(request.body ?? {}); return await engine.delegation.sync(auroraInput({ tenantId: b.tenantId, limit: b.limit })); });
app.post("/v1/delegations/:linkId/activate", async (request) => { const { linkId } = z.object({ linkId: z.string() }).parse(request.params); const b=auroraTenant.parse(request.body ?? {}); return await engine.delegation.activate(b.tenantId, linkId); });
app.post("/v1/delegations/:linkId/detach", async (request) => { const { linkId } = z.object({ linkId: z.string() }).parse(request.params); const b=auroraTenant.extend({reason:z.string().min(1).max(1000)}).parse(request.body); return await engine.delegation.detach(b.tenantId, linkId, b.reason); });
app.get("/v1/delegation-policy", async (request) => { const q=auroraTenant.parse(request.query); return await engine.delegation.policy(q.tenantId); });
app.post("/v1/delegation-policy", async (request) => { const b=auroraTenant.extend({autoDelegate:z.boolean().optional(),autoActivate:z.boolean().optional(),rootSessionId:z.string().max(200).nullable().optional(),maxActiveTasksPerPlan:z.number().int().min(1).max(100).optional(),maxTasksPerRun:z.number().int().min(1).max(25).optional(),requireRoleMatch:z.boolean().optional(),probation:z.object({minAttempts:z.number().int().min(1).max(1000).optional(),maxFailureRate:z.number().min(0).max(1).optional(),riskFloor:z.number().min(0).max(1).optional()}).optional()}).parse(request.body); const { tenantId, probation, ...rest } = b; return await engine.delegation.configure(auroraInput({ tenantId, ...(probation ? { probation: auroraInput(probation) } : {}), ...rest })); });
app.get("/v1/delegation-candidates", async (request) => { const q=auroraTenant.extend({capabilityTags:z.string().max(500).optional()}).parse(request.query); const tags=(q.capabilityTags ?? "").split(",").map((item)=>item.trim()).filter(Boolean).slice(0,20); return { candidates: await engine.delegation.candidates(q.tenantId, tags) }; });

// Aurora outcome harvesting — settled delegated work scored from recorded events
app.post("/v1/delegations/harvest", async (request) => { const b=auroraTenant.extend({planId:z.string().max(300).optional(),linkId:z.string().max(300).optional(),force:z.boolean().optional()}).parse(request.body ?? {}); return await engine.harvester.harvest(auroraInput(b)); });
app.get("/v1/delegations/:linkId/assessment", async (request) => { const { linkId } = z.object({ linkId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.harvester.assess(q.tenantId, linkId); });
app.get("/v1/harvest-assessments", async (request) => { const q=auroraTenant.extend({planId:z.string().max(300).optional(),disposition:z.enum(["recorded","review","skipped"]).optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { assessments: await engine.harvester.assessments(q.tenantId, auroraInput({ planId: q.planId, disposition: q.disposition, limit: q.limit })) }; });
app.get("/v1/harvest-review", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { review: await engine.harvester.reviewQueue(q.tenantId, q.limit ?? 50) }; });
app.post("/v1/harvest-review/:assessmentId/resolve", async (request) => { const { assessmentId } = z.object({ assessmentId: z.string() }).parse(request.params); const b=auroraTenant.extend({success:z.boolean(),quality:z.number().min(0).max(1).optional(),note:z.string().max(1000).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.harvester.resolveReview(auroraInput({ tenantId, assessmentId, ...rest })); });
app.get("/v1/harvest-policy", async (request) => { const q=auroraTenant.parse(request.query); return await engine.harvester.policy(q.tenantId); });

// Aurora plan feedback — decision outcomes derived from finished plans
app.get("/v1/decision-feedback/candidates", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { candidates: await engine.planFeedback.candidates(q.tenantId, q.limit ?? 50) }; });
app.post("/v1/decision-feedback/reconcile", async (request) => { const b=auroraTenant.extend({planId:z.string().max(300).optional(),dryRun:z.boolean().optional(),limit:z.number().int().min(1).max(200).optional()}).parse(request.body ?? {}); return await engine.planFeedback.reconcile(auroraInput(b)); });
app.get("/v1/decision-feedback", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { records: await engine.planFeedback.records(q.tenantId, q.limit ?? 50) }; });
app.get("/v1/decision-feedback/summary", async (request) => { const q=auroraTenant.parse(request.query); return await engine.planFeedback.summary(q.tenantId); });

// Aurora estimation calibration and society probation
app.get("/v1/estimation/profile", async (request) => { const q=auroraTenant.parse(request.query); return await engine.estimation.profile(q.tenantId); });
app.post("/v1/estimation/ingest", async (request) => { const b=auroraTenant.extend({planId:z.string().max(300).optional(),limit:z.number().int().min(1).max(1000).optional()}).parse(request.body ?? {}); return await engine.estimation.ingest(b.tenantId, auroraInput({ planId: b.planId, limit: b.limit })); });
app.get("/v1/estimation/samples", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { samples: await engine.estimation.samples(q.tenantId, q.limit ?? 100) }; });
app.get("/v1/plans/:planId/estimation", async (request) => { const { planId } = z.object({ planId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.estimation.suggest(q.tenantId, planId); });
app.post("/v1/plans/:planId/estimation/apply", async (request) => { const { planId } = z.object({ planId: z.string() }).parse(request.params); const b=auroraTenant.extend({minSamples:z.number().int().min(1).max(1000).optional()}).parse(request.body ?? {}); return await engine.estimation.apply(auroraInput({ tenantId: b.tenantId, planId, minSamples: b.minSamples })); });
app.get("/v1/society/probation", async (request) => { const q=auroraTenant.parse(request.query); return await engine.delegation.probationReport(q.tenantId); });

// Peer parity — repository instruction files, deterministic hooks and tool discovery
app.get("/v1/capabilities/search", async (request) => { const q=z.object({query:z.string().min(1).max(200),risk:z.string().max(50).optional(),sideEffect:z.coerce.boolean().optional(),source:z.string().max(20).optional(),limit:z.coerce.number().int().min(1).max(50).optional()}).parse(request.query); const results = searchCapabilities(engine.capabilities.list(), auroraInput(q)); return { query: q.query, catalogSize: engine.capabilities.list().length, results }; });
app.get("/v1/sessions/:sessionId/instructions", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const snapshot = await engine.session(sessionId); return await engine.projectInstructions.scan(snapshot.workspacePath); });
app.get("/v1/hooks", async (request) => { const q=auroraTenant.extend({event:z.enum(["session.start","session.stop","prompt.submit","tool.pre","tool.post"]).optional()}).parse(request.query); return { rules: await engine.lifecycleHooks.rules(q.tenantId, q.event) }; });
app.post("/v1/hooks", async (request, reply) => { const b=auroraTenant.extend({id:z.string().max(100).optional(),event:z.enum(["session.start","session.stop","prompt.submit","tool.pre","tool.post"]),description:z.string().min(1).max(500),action:z.enum(["allow","warn","require_approval","deny"]),reason:z.string().min(1).max(500),capabilityIds:z.array(z.string().min(1).max(200)).max(50).optional(),argumentPattern:z.string().max(500).optional(),runCapability:z.object({capabilityId:z.string().min(1).max(200),input:z.record(z.unknown()).optional()}).optional(),priority:z.number().int().min(1).max(1000).optional(),enabled:z.boolean().optional()}).parse(request.body); const { runCapability, ...rest } = b; return await reply.code(201).send(await engine.lifecycleHooks.define(auroraInput({ ...rest, ...(runCapability ? { runCapability: { capabilityId: runCapability.capabilityId, input: (runCapability.input ?? {}) as Record<string, unknown> } } : {}) }))); });
app.post("/v1/hooks/:ruleId/enabled", async (request) => { const { ruleId } = z.object({ ruleId: z.string() }).parse(request.params); const b=auroraTenant.extend({enabled:z.boolean()}).parse(request.body); return await engine.lifecycleHooks.setEnabled(b.tenantId, ruleId, b.enabled); });
app.delete("/v1/hooks/:ruleId", async (request) => { const { ruleId } = z.object({ ruleId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.lifecycleHooks.remove(q.tenantId, ruleId); });
app.get("/v1/hooks/firings", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { firings: await engine.lifecycleHooks.firings(q.tenantId, q.limit ?? 50) }; });
app.get("/v1/hooks/config", async (request) => { const q=auroraTenant.parse(request.query); return await engine.lifecycleHooks.config(q.tenantId); });
app.post("/v1/hooks/config", async (request) => { const b=auroraTenant.extend({enabled:z.boolean().optional(),allowCapabilityActions:z.boolean().optional(),actionAllowlist:z.array(z.string().min(1).max(200)).max(50).optional()}).parse(request.body); return await engine.lifecycleHooks.configure(auroraInput(b)); });

// Session permission and sandbox modes — the single named dial over the enforcement stack
app.get("/v1/session-modes", async () => engine.sessionModes.modes());
app.get("/v1/session-modes/defaults", async (request) => { const q=auroraTenant.parse(request.query); return await engine.sessionModes.defaults(q.tenantId); });
app.post("/v1/session-modes/defaults", async (request) => { const b=auroraTenant.extend({permissionMode:z.enum(["plan","manual","acceptEdits","auto","dontAsk","bypass"]).optional(),sandboxMode:z.enum(["read-only","workspace-write","danger-full-access"]).optional(),allowBypass:z.boolean().optional()}).parse(request.body); return await engine.sessionModes.setDefaults(auroraInput(b)); });
app.get("/v1/sessions/:sessionId/mode", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const snapshot = await engine.session(sessionId); return await engine.sessionModes.get(snapshot.tenantId, sessionId); });
app.post("/v1/sessions/:sessionId/mode", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({permissionMode:z.enum(["plan","manual","acceptEdits","auto","dontAsk","bypass"]).optional(),sandboxMode:z.enum(["read-only","workspace-write","danger-full-access"]).optional(),reason:z.string().min(1).max(1000),note:z.string().max(1000).optional(),actor:z.string().max(200).optional()}).parse(request.body); const snapshot = await engine.session(sessionId); return await engine.sessionModes.set(auroraInput({ tenantId: snapshot.tenantId, sessionId, actor: b.actor ?? "operator", permissionMode: b.permissionMode, sandboxMode: b.sandboxMode, reason: b.reason, note: b.note })); });
app.get("/v1/sessions/:sessionId/mode/history", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const q=z.object({limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); const snapshot = await engine.session(sessionId); return { transitions: await engine.sessionModes.transitions(snapshot.tenantId, auroraInput({ sessionId, limit: q.limit })) }; });

// Session archive, cost and repository command templates
app.get("/v1/sessions/:sessionId/cost", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); return await engine.sessionLifecycle.cost(sessionId); });
app.post("/v1/sessions/:sessionId/archive", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({reason:z.string().min(1).max(1000),actor:z.string().max(200).optional()}).parse(request.body); const snapshot = await engine.session(sessionId); return await engine.sessionLifecycle.archive(auroraInput({ tenantId: snapshot.tenantId, sessionId, reason: b.reason, actor: b.actor })); });
app.post("/v1/sessions/:sessionId/restore", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({reason:z.string().min(1).max(1000),actor:z.string().max(200).optional()}).parse(request.body); const snapshot = await engine.session(sessionId); return await engine.sessionLifecycle.restore(auroraInput({ tenantId: snapshot.tenantId, sessionId, reason: b.reason, actor: b.actor })); });
// Close session (idempotent — already-closed sessions return their snapshot)
app.post("/v1/sessions/:sessionId/close", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); return await engine.closeSession(sessionId); });
app.get("/v1/session-archives", async (request) => { const q=auroraTenant.extend({state:z.enum(["active","archived"]).optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { records: await engine.sessionLifecycle.list(q.tenantId, auroraInput({ state: q.state, limit: q.limit })) }; });
app.get("/v1/usage", async (request) => { const q=auroraTenant.extend({limit:z.coerce.number().int().min(1).max(100).optional()}).parse(request.query); return await engine.sessionLifecycle.usage(q.tenantId, auroraInput({ limit: q.limit })); });
app.get("/v1/model-prices", async (request) => { const q=auroraTenant.parse(request.query); return { prices: await engine.sessionLifecycle.prices(q.tenantId) }; });
app.post("/v1/model-prices", async (request) => { const b=auroraTenant.extend({route:z.string().min(1).max(200),inputPerMillionUsd:z.number().min(0).max(100_000),outputPerMillionUsd:z.number().min(0).max(100_000),cacheReadPerMillionUsd:z.number().min(0).max(100_000).optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.sessionLifecycle.setPrice(auroraInput(rest)); });
app.delete("/v1/model-prices/:route", async (request) => { const { route } = z.object({ route: z.string() }).parse(request.params); return await engine.sessionLifecycle.removePrice(decodeURIComponent(route)); });
app.get("/v1/sessions/:sessionId/commands", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const snapshot = await engine.session(sessionId); return await engine.repositoryCommands.list(snapshot.workspacePath); });
app.post("/v1/sessions/:sessionId/commands/:name/render", async (request) => { const { sessionId, name } = z.object({ sessionId: z.string(), name: z.string().min(1).max(60) }).parse(request.params); const b=z.object({arguments:z.array(z.string().max(10_000)).max(20).optional()}).parse(request.body ?? {}); const snapshot = await engine.session(sessionId); return await engine.repositoryCommands.render(auroraInput({ workspacePath: snapshot.workspacePath, name, arguments: b.arguments })); });

// Working-tree review and declarative subagent files
app.post("/v1/sessions/:sessionId/review", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({base:z.string().max(200).optional(),staged:z.boolean().optional(),maxFiles:z.number().int().min(1).max(5000).optional(),maxDiffChars:z.number().int().min(1000).max(2_000_000).optional()}).parse(request.body ?? {}); const snapshot = await engine.session(sessionId); const review = await engine.worktreeReview.review(auroraInput({ workspacePath: snapshot.workspacePath, ...b })); return { ...review, ...reviewVerdict(review) }; });
app.get("/v1/sessions/:sessionId/subagents", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const snapshot = await engine.session(sessionId); return await engine.subagents.list(snapshot.workspacePath); });
app.get("/v1/sessions/:sessionId/subagents/:name", async (request) => { const { sessionId, name } = z.object({ sessionId: z.string(), name: z.string().min(1).max(60) }).parse(request.params); const snapshot = await engine.session(sessionId); return await engine.subagents.resolve(snapshot.workspacePath, name); });
app.post("/v1/sessions/:sessionId/subagents/:name/materialize", async (request) => { const { sessionId, name } = z.object({ sessionId: z.string(), name: z.string().min(1).max(60) }).parse(request.params); const b=z.object({bindRole:z.boolean().optional()}).parse(request.body ?? {}); const snapshot = await engine.session(sessionId); return await engine.subagents.materialize(auroraInput({ tenantId: snapshot.tenantId, workspacePath: snapshot.workspacePath, name, bindRole: b.bindRole })); });
app.post("/v1/sessions/:sessionId/subagents/materialize-all", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const snapshot = await engine.session(sessionId); return { applied: await engine.subagents.materializeAll({ tenantId: snapshot.tenantId, workspacePath: snapshot.workspacePath }) }; });

// Per-session effort and deliberate worktrees
app.get("/v1/effort-levels", async () => ({ levels: engine.sessionEffort.levels() }));
app.get("/v1/sessions/:sessionId/effort", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const snapshot = await engine.session(sessionId); return await engine.sessionEffort.get(snapshot.tenantId, sessionId); });
app.post("/v1/sessions/:sessionId/effort", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({level:z.enum(["low","medium","high","xhigh","max"]),note:z.string().max(500).optional(),actor:z.string().max(200).optional()}).parse(request.body); const snapshot = await engine.session(sessionId); return await engine.sessionEffort.set(auroraInput({ tenantId: snapshot.tenantId, sessionId, level: b.level, note: b.note, actor: b.actor ?? "operator" })); });
app.post("/v1/effort-defaults", async (request) => { const b=auroraTenant.extend({level:z.enum(["low","medium","high","xhigh","max"])}).parse(request.body); return await engine.sessionEffort.setDefault(b.tenantId, b.level); });
app.get("/v1/sessions/:sessionId/worktrees", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const snapshot = await engine.session(sessionId); return { worktrees: await engine.worktrees.list(snapshot.workspacePath) }; });
app.post("/v1/sessions/:sessionId/worktrees", async (request, reply) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({branch:z.string().min(1).max(200),base:z.string().max(200).optional(),createSession:z.boolean().optional(),name:z.string().max(200).optional()}).parse(request.body); const snapshot = await engine.session(sessionId); const worktree = await engine.worktrees.create(auroraInput({ workspacePath: snapshot.workspacePath, branch: b.branch, base: b.base })); const created = b.createSession === false ? undefined : await engine.createSession(auroraInput({ tenantId: snapshot.tenantId, name: b.name ?? `${snapshot.name} · ${b.branch}`, workspacePath: worktree.path })); return await reply.code(201).send({ worktree, ...(created ? { session: { sessionId: created.sessionId, name: created.name, workspacePath: created.workspacePath } } : {}) }); });
app.delete("/v1/sessions/:sessionId/worktrees", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const q=z.object({path:z.string().min(1).max(4096),force:z.coerce.boolean().optional()}).parse(request.query); const snapshot = await engine.session(sessionId); return await engine.worktrees.remove(auroraInput({ workspacePath: snapshot.workspacePath, path: q.path, force: q.force })); });

// Supply-chain trust: publisher keys, version pins and verification verdicts
app.get("/v1/trust/publishers", async () => ({ publishers: await engine.manifestTrust.publishers() }));
app.post("/v1/trust/publishers", async (request, reply) => { const b=z.object({id:z.string().min(2).max(100),name:z.string().min(1).max(200),publicKey:z.string().min(40).max(8000),note:z.string().max(500).optional(),actor:z.string().max(200).optional()}).parse(request.body); return await reply.code(201).send(await engine.manifestTrust.addPublisher(auroraInput({ id: b.id, name: b.name, publicKey: b.publicKey, note: b.note, addedBy: b.actor }))); });
app.delete("/v1/trust/publishers/:id", async (request) => { const { id } = z.object({ id: z.string() }).parse(request.params); return await engine.manifestTrust.removePublisher(id); });
app.get("/v1/trust/pins", async (request) => { const q=z.object({kind:z.enum(["skill","plugin","microagent"]).optional()}).parse(request.query); return { pins: await engine.manifestTrust.pins(q.kind) }; });
app.post("/v1/trust/pins", async (request, reply) => { const b=z.object({kind:z.enum(["skill","plugin","microagent"]),artifactId:z.string().min(1).max(300),version:z.string().min(1).max(100),sha256:z.string().length(64),reason:z.string().max(500).optional(),actor:z.string().max(200).optional()}).parse(request.body); return await reply.code(201).send(await engine.manifestTrust.pin(auroraInput({ kind: b.kind, artifactId: b.artifactId, version: b.version, sha256: b.sha256, reason: b.reason, pinnedBy: b.actor }))); });
app.delete("/v1/trust/pins/:kind/:artifactId", async (request) => { const p=z.object({kind:z.enum(["skill","plugin","microagent"]),artifactId:z.string()}).parse(request.params); return await engine.manifestTrust.unpin(p.kind, decodeURIComponent(p.artifactId)); });
app.get("/v1/trust/policy", async (request) => { const q=auroraTenant.parse(request.query); return await engine.manifestTrust.policy(q.tenantId); });
app.post("/v1/trust/policy", async (request) => { const b=auroraTenant.extend({requireSignature:z.boolean().optional(),requirePin:z.boolean().optional()}).parse(request.body); return await engine.manifestTrust.configure(auroraInput(b)); });
app.get("/v1/trust/decisions", async (request) => { const q=z.object({limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { decisions: await engine.manifestTrust.decisions(q.limit ?? 50) }; });
app.post("/v1/trust/evaluate", async (request) => { const b=auroraTenant.extend({kind:z.enum(["skill","plugin","microagent"]),artifactId:z.string().min(1).max(300),version:z.string().min(1).max(100),sha256:z.string().length(64),signature:z.string().max(2000).optional(),publisherId:z.string().max(100).optional()}).parse(request.body); return await engine.manifestTrust.evaluate(auroraInput(b)); });

// Layered settings with provenance, and structured questions to the human
app.get("/v1/settings/effective", async (request) => { const q=auroraTenant.extend({sessionId:z.string().max(200).optional()}).parse(request.query); const workspacePath = q.sessionId ? (await engine.session(q.sessionId)).workspacePath : undefined; return await engine.settings.effective(auroraInput({ tenantId: q.tenantId, workspacePath })); });
app.get("/v1/questions", async (request) => { const q=auroraTenant.extend({sessionId:z.string().max(200).optional(),pendingOnly:z.coerce.boolean().optional(),limit:z.coerce.number().int().min(1).max(500).optional()}).parse(request.query); return { questions: engine.userQuestions.list(auroraInput({ tenantId: q.tenantId, sessionId: q.sessionId, pendingOnly: q.pendingOnly, limit: q.limit })) }; });
app.post("/v1/questions/:questionId/answer", async (request) => { const { questionId } = z.object({ questionId: z.string() }).parse(request.params); const b=z.object({optionId:z.string().max(100).optional(),text:z.string().max(5000).optional(),answeredBy:z.string().max(200).optional()}).parse(request.body); return engine.userQuestions.answer(auroraInput({ questionId, ...b })); });
app.post("/v1/questions/:questionId/cancel", async (request) => { const { questionId } = z.object({ questionId: z.string() }).parse(request.params); const b=z.object({reason:z.string().max(500).optional()}).parse(request.body ?? {}); return engine.userQuestions.cancel(questionId, b.reason ?? "cancelled by operator"); });

// MCP 2026-07-28 stateless servers
app.get("/v1/mcp/stateless", async () => ({ servers: engine.statelessMcp.list() }));
app.post("/v1/mcp/stateless", async (request, reply) => { const b=z.object({name:z.string().min(1).max(100),endpoint:z.string().min(1).max(2000),allowPlainHttp:z.boolean().optional(),headers:z.record(z.string().max(2000)).optional(),requestTimeoutMs:z.number().int().min(1000).max(600_000).optional(),listCacheTtlMs:z.number().int().min(0).max(3_600_000).optional(),maxInputRounds:z.number().int().min(1).max(10).optional()}).parse(request.body); return await reply.code(201).send(await engine.statelessMcp.connect(auroraInput(b))); });
app.post("/v1/mcp/stateless/:name/refresh", async (request) => { const { name } = z.object({ name: z.string() }).parse(request.params); return await engine.statelessMcp.refresh(name); });
app.delete("/v1/mcp/stateless/:name", async (request) => { const { name } = z.object({ name: z.string() }).parse(request.params); return await engine.statelessMcp.disconnect(name); });

// Background task control: what is running under a session, and how to stop or resume it
app.get("/v1/sessions/:sessionId/tasks/monitor", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const snapshot = await engine.session(sessionId); const roster = await engine.supervisor.familyRoster(sessionId); const agents = []; for (const entry of roster) { const child = await engine.session(entry.sessionId).catch(() => undefined); if (!child) continue; const usage = child.totalUsage ?? { inputTokens: 0, outputTokens: 0 }; agents.push({ sessionId: entry.sessionId, name: child.name, relationship: entry.relationship, status: child.status, busy: Boolean(child.activeTurnId), totalTokens: usage.inputTokens + usage.outputTokens, updatedAt: child.updatedAt, mode: (await engine.sessionModes.get(snapshot.tenantId, entry.sessionId)).permissionMode, effort: (await engine.sessionEffort.get(snapshot.tenantId, entry.sessionId)).level, openQuestions: engine.userQuestions.list({ sessionId: entry.sessionId, pendingOnly: true }).length }); } return { currentSessionId: sessionId, agents, generatedAt: new Date().toISOString() }; });
app.post("/v1/sessions/:sessionId/tasks/stop", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({targetSessionId:z.string().min(1).max(200),mode:z.enum(["cancel","close"]).optional(),reason:z.string().min(1).max(1000)}).parse(request.body); const snapshot = await engine.session(sessionId); const roster = await engine.supervisor.familyRoster(sessionId); if (!roster.some((item) => item.sessionId === b.targetSessionId)) throw new Error("Target agent is not within this session's family reach."); return await engine.command({ protocolVersion: 1, commandId: randomUUID(), clientId: "control-api", tenantId: snapshot.tenantId, sessionId: b.targetSessionId, kind: b.mode === "close" ? "session.close" : "session.cancel", source: "api", issuedAt: new Date().toISOString(), payload: { reason: b.reason } }); });
// Project verification: what this project checks itself with, and the evidence of the last run
app.get("/v1/sessions/:sessionId/verification", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const q=z.object({limit:z.coerce.number().int().min(1).max(50).optional()}).parse(request.query); const snapshot = await engine.session(sessionId); return { recipe: await engine.verification.detect(snapshot.workspacePath), latest: await engine.verification.latest(snapshot.tenantId, sessionId), history: await engine.verification.list(auroraInput({ tenantId: snapshot.tenantId, sessionId, limit: q.limit })) }; });
app.post("/v1/sessions/:sessionId/verification/run", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({phases:z.array(z.enum(["bootstrap","build","test","lint"])).min(1).max(4).optional(),timeoutMs:z.number().int().min(1000).max(3_600_000).optional()}).parse(request.body ?? {}); const snapshot = await engine.session(sessionId); return await engine.verification.run(auroraInput({ tenantId: snapshot.tenantId, sessionId, workspacePath: snapshot.workspacePath, phases: b.phases, timeoutMs: b.timeoutMs })); });
// Code intelligence: language server / toolchain diagnostics, symbols, definition and references
const plainFile = z.object({ path: z.string().min(1).max(500), line: z.number().int().min(1).max(10_000_000), column: z.number().int().min(1).max(10_000_000) });
app.get("/v1/sessions/:sessionId/code", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const snapshot = await engine.session(sessionId); return { catalog: await engine.codeIntelligence.catalog(snapshot.workspacePath), latest: await engine.codeIntelligence.latest(snapshot.tenantId, sessionId) }; });
app.get("/v1/sessions/:sessionId/diagnostics", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const q=z.object({limit:z.coerce.number().int().min(1).max(50).optional()}).parse(request.query); const snapshot = await engine.session(sessionId); return { latest: await engine.codeIntelligence.latest(snapshot.tenantId, sessionId), history: await engine.codeIntelligence.list(auroraInput({ tenantId: snapshot.tenantId, sessionId, limit: q.limit })) }; });
app.post("/v1/sessions/:sessionId/code/diagnostics/run", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({files:z.array(z.string().min(1).max(500)).max(60).optional(),severities:z.array(z.enum(["error","warning","info","hint"])).min(1).max(4).optional(),forceToolchain:z.boolean().optional(),timeoutMs:z.number().int().min(1000).max(3_600_000).optional()}).parse(request.body ?? {}); const snapshot = await engine.session(sessionId); return await engine.codeIntelligence.runDiagnostics(auroraInput({ tenantId: snapshot.tenantId, sessionId, workspacePath: snapshot.workspacePath, files: b.files, severities: b.severities, forceToolchain: b.forceToolchain })); });
app.post("/v1/sessions/:sessionId/code/symbols", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({path:z.string().min(1).max(500).optional()}).parse(request.body ?? {}); const snapshot = await engine.session(sessionId); return await engine.codeIntelligence.symbols(auroraInput({ tenantId: snapshot.tenantId, sessionId, workspacePath: snapshot.workspacePath, path: b.path })); });
app.post("/v1/sessions/:sessionId/code/definition", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=plainFile.parse(request.body ?? {}); const snapshot = await engine.session(sessionId); return await engine.codeIntelligence.definition(auroraInput({ tenantId: snapshot.tenantId, sessionId, workspacePath: snapshot.workspacePath, path: b.path, line: b.line, column: b.column })); });
app.post("/v1/sessions/:sessionId/code/references", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=plainFile.extend({includeDeclaration:z.boolean().optional()}).parse(request.body ?? {}); const snapshot = await engine.session(sessionId); return await engine.codeIntelligence.references(auroraInput({ tenantId: snapshot.tenantId, sessionId, workspacePath: snapshot.workspacePath, path: b.path, line: b.line, column: b.column, includeDeclaration: b.includeDeclaration })); });
// Prompt-cache plans: what the last request paid for, and whether the next one would hit cache
app.get("/v1/sessions/:sessionId/cache/plan", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const q=z.object({limit:z.coerce.number().int().min(1).max(50).optional()}).parse(request.query); const snapshot = await engine.session(sessionId); return { latest: await engine.promptCache.latest(snapshot.tenantId, sessionId), history: await engine.promptCache.list(auroraInput({ tenantId: snapshot.tenantId, sessionId, limit: q.limit })) }; });
app.post("/v1/sessions/:sessionId/cache/config", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({enabled:z.boolean().optional(),ttlMs:z.union([z.literal(300_000),z.literal(3_600_000)]).optional()}).parse(request.body ?? {}); const snapshot = await engine.session(sessionId); return await engine.promptCache.config(snapshot.tenantId, sessionId, auroraInput({ enabled: b.enabled, ttlMs: b.ttlMs })); });

// Tenant-wide agent directory, and messaging outside family reach
app.get("/v1/agent-directory", async (request) => { const q=auroraTenant.extend({query:z.string().max(200).optional(),includeClosed:z.coerce.boolean().optional(),limit:z.coerce.number().int().min(1).max(500).optional()}).parse(request.query); return { agents: await engine.supervisor.directory(q.tenantId, auroraInput({ query: q.query, includeClosed: q.includeClosed, limit: q.limit })) }; });
app.post("/v1/sessions/:sessionId/messages/direct", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({message:z.string().min(1).max(16_384),targetSessionId:z.string().max(200).optional(),targetName:z.string().max(200).optional(),mode:z.enum(["auto","steer","follow_up"]).optional()}).parse(request.body); return await engine.supervisor.sendDirectedMessage(auroraInput({ senderSessionId: sessionId, ...b })); });

// Child-agent fan-out budget, and session spend budgets
app.get("/v1/sessions/:sessionId/fanout", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); return await engine.supervisor.fanoutStatus(sessionId); });
app.get("/v1/sessions/:sessionId/budget", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const snapshot = await engine.session(sessionId); return await engine.budgetVerdict(snapshot.tenantId, sessionId); });
app.post("/v1/sessions/:sessionId/budget", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({maxUsd:z.number().positive().max(1_000_000).optional(),maxTokens:z.number().int().positive().optional(),warnAtFraction:z.number().min(0.1).max(0.99).optional(),onExceeded:z.enum(["block","warn"]).optional(),reason:z.string().min(1).max(1000),setBy:z.string().max(200).optional()}).parse(request.body); const snapshot = await engine.session(sessionId); return await engine.sessionBudgets.setSessionBudget(auroraInput({ tenantId: snapshot.tenantId, sessionId, ...b })); });
app.delete("/v1/sessions/:sessionId/budget", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const snapshot = await engine.session(sessionId); return { removed: await engine.sessionBudgets.clearSessionBudget(snapshot.tenantId, sessionId) }; });
app.get("/v1/session-budgets", async (request) => { const q=auroraTenant.parse(request.query); return { defaults: await engine.sessionBudgets.defaults(q.tenantId) ?? null, overrides: await engine.sessionBudgets.overrides(q.tenantId) }; });
app.post("/v1/session-budgets/defaults", async (request) => { const b=auroraTenant.extend({maxUsd:z.number().positive().max(1_000_000).optional(),maxTokens:z.number().int().positive().optional(),warnAtFraction:z.number().min(0.1).max(0.99).optional(),onExceeded:z.enum(["block","warn"]).optional()}).parse(request.body); return await engine.sessionBudgets.setTenantDefaults(auroraInput(b)); });

// Long-running shells: start one, follow its output, kill it
app.get("/v1/sessions/:sessionId/shells", async (request) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const q=z.object({runningOnly:z.coerce.boolean().optional(),limit:z.coerce.number().int().min(1).max(200).optional()}).parse(request.query); const snapshot = await engine.session(sessionId); return { shells: engine.backgroundShells.list(auroraInput({ tenantId: snapshot.tenantId, sessionId, runningOnly: q.runningOnly, limit: q.limit })) }; });
app.post("/v1/sessions/:sessionId/shells", async (request, reply) => { const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params); const b=z.object({command:z.string().min(1).max(50_000),cwd:z.string().max(1000).optional(),label:z.string().max(200).optional(),timeoutMs:z.number().int().min(1000).max(3_600_000).optional()}).parse(request.body); const snapshot = await engine.session(sessionId); return await reply.code(201).send(await engine.backgroundShells.start(auroraInput({ tenantId: snapshot.tenantId, sessionId, workspacePath: snapshot.workspacePath, command: b.command, cwd: b.cwd, label: b.label, timeoutMs: b.timeoutMs }))); });
app.get("/v1/sessions/:sessionId/shells/:shellId/output", async (request) => { const { sessionId, shellId } = z.object({ sessionId: z.string(), shellId: z.string() }).parse(request.params); const q=z.object({cursor:z.coerce.number().int().min(0).optional(),maxChars:z.coerce.number().int().min(100).max(200_000).optional(),waitMs:z.coerce.number().int().min(0).max(60_000).optional()}).parse(request.query); return await engine.backgroundShells.output(auroraInput({ shellId, sessionId, cursor: q.cursor, maxChars: q.maxChars, waitMs: q.waitMs })); });
app.post("/v1/sessions/:sessionId/shells/:shellId/stop", async (request) => { const { sessionId, shellId } = z.object({ sessionId: z.string(), shellId: z.string() }).parse(request.params); const b=z.object({reason:z.string().min(1).max(1000).optional()}).parse(request.body ?? {}); return await engine.backgroundShells.stop({ shellId, sessionId, reason: b.reason ?? "stopped by operator" }); });

// Reviewed automatic approvals: rules an operator writes, and the decisions they produced
app.get("/v1/auto-approvals", async (request) => { const q=auroraTenant.parse(request.query); return { rules: await engine.autoApprovals.listRules(q.tenantId) }; });
app.post("/v1/auto-approvals", async (request, reply) => { const b=auroraTenant.extend({id:z.string().max(200).optional(),capabilityPattern:z.string().min(1).max(200),rationale:z.string().min(10).max(2000),riskClasses:z.array(z.enum(["pure","workspace_read","workspace_write","process","network","external_side_effect","privileged"])).max(7).optional(),argumentPatterns:z.array(z.string().min(1).max(300)).max(10).optional(),refusePatterns:z.array(z.string().min(1).max(300)).max(10).optional(),sessionIds:z.array(z.string().min(1).max(200)).max(20).optional(),enabled:z.boolean().optional(),maxUses:z.number().int().min(1).max(10_000).optional(),expiresAt:z.string().datetime().optional(),createdBy:z.string().max(200).optional()}).parse(request.body); return await reply.code(201).send(await engine.autoApprovals.upsertRule(auroraInput(b))); });
app.post("/v1/auto-approvals/:ruleId/enabled", async (request) => { const { ruleId } = z.object({ ruleId: z.string() }).parse(request.params); const b=auroraTenant.extend({enabled:z.boolean()}).parse(request.body); return await engine.autoApprovals.setEnabled(b.tenantId, ruleId, b.enabled); });
app.delete("/v1/auto-approvals/:ruleId", async (request) => { const { ruleId } = z.object({ ruleId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return { removed: await engine.autoApprovals.removeRule(q.tenantId, ruleId) }; });
app.get("/v1/auto-approvals/decisions", async (request) => { const q=auroraTenant.extend({sessionId:z.string().max(200).optional(),limit:z.coerce.number().int().min(1).max(500).optional()}).parse(request.query); return { decisions: await engine.autoApprovals.listDecisions(auroraInput({ tenantId: q.tenantId, sessionId: q.sessionId, limit: q.limit })) }; });

app.post("/v1/harvest-policy", async (request) => { const b=auroraTenant.extend({autoRecord:z.boolean().optional(),successAtOrAbove:z.number().min(0).max(1).optional(),failBelow:z.number().min(0).max(1).optional(),settleAfterMs:z.number().int().min(0).max(86_400_000).optional(),maxPerRun:z.number().int().min(1).max(200).optional(),learnFromFailures:z.boolean().optional()}).parse(request.body); return await engine.harvester.configure(auroraInput(b)); });

// Aurora role authority — least-privilege capability allowlists for the society
app.get("/v1/society/authority/templates", async (request) => { const q=auroraTenant.parse(request.query); return { templates: await engine.roleAuthority.allTemplates(q.tenantId) }; });
app.get("/v1/society/authority/templates/:templateId", async (request) => { const { templateId } = z.object({ templateId: z.string().min(1).max(100) }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.roleAuthority.resolveFor(q.tenantId, templateId); });
app.post("/v1/society/authority/templates", async (request, reply) => { const b=auroraTenant.extend({id:z.string().min(2).max(60),title:z.string().min(1).max(200),rationale:z.string().min(1).max(2000),roleIds:z.array(z.string().min(1).max(200)).max(50).optional(),allow:z.array(z.string().min(1).max(200)).min(1).max(100),deny:z.array(z.string().min(1).max(200)).max(100).optional(),maxRisk:z.enum(["pure","workspace_read","workspace_write","process","network","external_side_effect","privileged"])}).parse(request.body); return await reply.code(201).send(await engine.roleAuthority.defineTemplate(auroraInput(b))); });
app.delete("/v1/society/authority/templates/:templateId", async (request) => { const { templateId } = z.object({ templateId: z.string().min(1).max(100) }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.roleAuthority.removeTemplate(q.tenantId, templateId); });
app.post("/v1/society/authority/apply", async (request) => { const b=auroraTenant.extend({templateId:z.string().min(1).max(100),roleIds:z.array(z.string().min(1).max(200)).max(50).optional(),bind:z.boolean().optional(),modelRoute:z.string().max(300).optional()}).parse(request.body); return await engine.roleAuthority.apply(auroraInput(b)); });
app.post("/v1/society/authority/apply-all", async (request) => { const b=auroraTenant.parse(request.body ?? {}); return { applied: await engine.roleAuthority.applyAll(b.tenantId) }; });
app.get("/v1/society/authority/audit", async (request) => { const q=auroraTenant.parse(request.query); return await engine.roleAuthority.audit(q.tenantId); });

app.get("/v1/aurora/explain", async (request) => { const q=auroraTenant.extend({kind:z.enum(["cognitive-object","initiative","intake","memory","world-entity","world-event","environment-action","environment-resource","decision","plan","constitution-verdict"]),id:z.string().min(1).max(300),depth:z.coerce.number().int().min(1).max(6).optional()}).parse(request.query); return await engine.provenance.explain(auroraInput({ tenantId: q.tenantId, kind: q.kind, id: q.id, depth: q.depth })); });

// ---------------------------------------------------------------------------
// Aurora operations — workspace checkpoints, telemetry, governance and integrity
// ---------------------------------------------------------------------------
app.get("/v1/checkpoints", async (request) => { const q=auroraTenant.extend({sessionId:z.string().optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { checkpoints: await engine.checkpoints.list(q.tenantId, auroraInput({ sessionId: q.sessionId, limit: q.limit })) }; });
app.post("/v1/checkpoints", async (request, reply) => { const b=auroraTenant.extend({workspacePath:z.string().min(1).max(2000),label:z.string().min(1).max(200),reason:z.string().min(1).max(2000),sessionId:z.string().optional(),actionId:z.string().max(300).optional(),maxFiles:z.number().int().min(1).max(50_000).optional(),maxTotalBytes:z.number().int().min(1024).max(1_073_741_824).optional()}).parse(request.body); const { tenantId, maxFiles, maxTotalBytes, ...rest } = b; return await reply.code(201).send(await engine.checkpoints.capture(auroraInput({ tenantId, ...rest, limits: auroraInput({ maxFiles, maxTotalBytes }) }))); });
app.get("/v1/checkpoints/:checkpointId", async (request) => { const { checkpointId } = z.object({ checkpointId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.checkpoints.get(q.tenantId, checkpointId); });
app.post("/v1/checkpoints/:checkpointId/diff", async (request) => { const { checkpointId } = z.object({ checkpointId: z.string() }).parse(request.params); const b=auroraTenant.extend({workspacePath:z.string().min(1).max(2000)}).parse(request.body); return await engine.checkpoints.diff(b.tenantId, checkpointId, b.workspacePath); });
app.post("/v1/checkpoints/:checkpointId/restore", async (request) => { const { checkpointId } = z.object({ checkpointId: z.string() }).parse(request.params); const b=auroraTenant.extend({workspacePath:z.string().min(1).max(2000),removeAddedFiles:z.boolean().optional(),safetyCheckpoint:z.boolean().optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.checkpoints.restore(auroraInput({ tenantId, checkpointId, ...rest })); });
app.delete("/v1/checkpoints/:checkpointId", async (request) => { const { checkpointId } = z.object({ checkpointId: z.string() }).parse(request.params); const q=auroraTenant.parse(request.query); return await engine.checkpoints.remove(q.tenantId, checkpointId); });
app.get("/v1/checkpoints-usage", async (request) => { const q=auroraTenant.parse(request.query); return await engine.checkpoints.usage(q.tenantId); });

app.get("/v1/aurora/metrics", async (request) => { const q=auroraTenant.parse(request.query); return await engine.auroraMetrics.snapshot(q.tenantId); });
app.get("/v1/aurora/metrics.prom", async (request, reply) => { const q=auroraTenant.parse(request.query); await reply.header("content-type", "text/plain; version=0.0.4"); return await engine.auroraMetrics.prometheus(q.tenantId); });
app.get("/v1/aurora/alerts", async (request) => { const q=auroraTenant.parse(request.query); return { alerts: await engine.auroraMetrics.alerts(q.tenantId) }; });
app.get("/v1/aurora/export", async (request) => { const q=auroraTenant.extend({userId:z.string().max(200).optional(),includeContent:z.coerce.boolean().optional()}).parse(request.query); return await engine.dataGovernance.export(auroraInput({ tenantId: q.tenantId, userId: q.userId, includeContent: q.includeContent })); });
app.post("/v1/aurora/purge-user", async (request) => { const b=auroraTenant.extend({userId:z.string().min(1).max(200),dryRun:z.boolean().optional()}).parse(request.body); const { tenantId, ...rest } = b; return await engine.dataGovernance.purgeUser(auroraInput({ tenantId, ...rest })); });
app.get("/v1/aurora/selfcheck", async (request) => { const q=auroraTenant.parse(request.query); return await engine.dataGovernance.selfCheck(q.tenantId); });
app.get("/v1/aurora/footprint", async (request) => { const q=auroraTenant.parse(request.query); return await engine.dataGovernance.footprint(q.tenantId); });

app.get("/v1/aurora/enforcement", async (request) => { const q=auroraTenant.extend({escalatedOnly:z.coerce.boolean().optional(),limit:z.coerce.number().int().min(1).max(1000).optional()}).parse(request.query); return { decisions: engine.auroraPolicy ? await engine.auroraPolicy.decisions(q.tenantId, auroraInput({ escalatedOnly: q.escalatedOnly, limit: q.limit })) : [] }; });
app.get("/v1/aurora/enforcement-summary", async (request) => { const q=auroraTenant.extend({windowDays:z.coerce.number().int().min(1).max(365).optional()}).parse(request.query); return engine.auroraPolicy ? await engine.auroraPolicy.summary(q.tenantId, q.windowDays ?? 7) : { tenantId: q.tenantId, total: 0, escalated: 0, denied: 0, escalationRate: 0, byLevel: {}, topRules: [], topPrinciples: [], generatedAt: new Date().toISOString() }; });

app.get("/v1/media/images/providers", async () => ({ providers: engine.images.list(), upscalers: engine.images.listUpscalers() }));
app.get("/v1/media/videos/providers", async () => ({ providers: engine.video.list(), queuedProviders: engine.video.listQueued(), upscalers: engine.video.listUpscalers() }));
app.get("/v1/web-search/providers", async () => ({ providers: engine.webSearch.list() }));
app.get("/v1/providers", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return {
  active: engine.models.list(),
  routes: engine.models.status(),
  profiles: engine.providerProfiles.list().map((profile) => ({
    ...profile,
    configured: profile.dataPolicy === "local" || profile.credentialMode === "aws-default" || Boolean(process.env[profile.apiKeyEnvironmentVariable]) || provider === profile.id,
  })),
  configurations: await engine.modelConfigurations.list(tenantId),
  };
});
app.post("/v1/providers/:providerId/credentials/reset", async (request) => {
  const { providerId } = z.object({ providerId: z.string().min(1).max(100) }).parse(request.params);
  const { credentialId } = z.object({ credentialId: z.string().min(1).max(100).optional() }).parse(request.body ?? {});
  return await engine.models.resetCredentialPool(providerId, credentialId);
});

app.get("/v1/agent-profiles", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { profiles: await engine.agentProfiles.list(tenantId) };
});
app.post("/v1/agent-profiles", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    instructions: z.string().min(1).max(50_000),
    allowedCapabilityIds: z.array(z.string()).max(500).optional(),
    modelRoute: z.string().max(300).optional(),
    fallbackModels: z.array(z.string()).max(8).optional(),
  }).parse(request.body);
  return await reply.code(201).send(await engine.agentProfiles.add({
    tenantId: body.tenantId,
    name: body.name,
    instructions: body.instructions,
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.allowedCapabilityIds ? { allowedCapabilityIds: body.allowedCapabilityIds } : {}),
    ...(body.modelRoute ? { modelRoute: body.modelRoute } : {}),
    ...(body.fallbackModels ? { fallbackModels: body.fallbackModels } : {}),
  }));
});
app.patch("/v1/agent-profiles/:profileId", async (request) => {
  const { profileId } = z.object({ profileId: z.string() }).parse(request.params);
  const body = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    instructions: z.string().min(1).max(50_000).optional(),
    allowedCapabilityIds: z.array(z.string()).max(500).nullable().optional(),
    modelRoute: z.string().max(300).nullable().optional(),
    fallbackModels: z.array(z.string()).max(8).optional(),
    enabled: z.boolean().optional(),
  }).parse(request.body);
  return await engine.agentProfiles.update(profileId, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
    ...(body.allowedCapabilityIds !== undefined ? { allowedCapabilityIds: body.allowedCapabilityIds } : {}),
    ...(body.modelRoute !== undefined ? { modelRoute: body.modelRoute } : {}),
    ...(body.fallbackModels !== undefined ? { fallbackModels: body.fallbackModels } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
  });
});
app.delete("/v1/agent-profiles/:profileId", async (request, reply) => {
  const { profileId } = z.object({ profileId: z.string() }).parse(request.params);
  const removed = await engine.agentProfiles.remove(profileId);
  return removed ? await reply.code(204).send() : await reply.code(404).send({ error: "agent_profile_not_found" });
});

app.get("/v1/model-auth/codex/status", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return await engine.codexAuth.status(tenantId);
});
app.get("/v1/model-auth/codex/models", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { models: await engine.codexAuth.listModels(tenantId) };
});
app.post("/v1/model-auth/codex/start", async (request, reply) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.body ?? {});
  return await reply.code(201).send(await engine.codexAuth.startDeviceFlow(tenantId));
});
app.post("/v1/model-auth/codex/poll", async (request, reply) => {
  const body = z.object({ tenantId: z.string().default("local"), flowId: z.string().uuid() }).parse(request.body);
  const result = await engine.codexAuth.pollDeviceFlow(body.tenantId, body.flowId);
  return await reply.code(result.status === "pending" ? 202 : 200).send(result);
});
app.post("/v1/model-auth/codex/activate", async (request) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    model: z.string().min(1).max(300),
    reasoningEffort: z.enum(["low", "medium", "high", "max"]).optional(),
    requestTimeoutMs: z.number().int().min(5_000).max(600_000).optional(),
  }).parse(request.body);
  const status = await engine.codexAuth.status(body.tenantId);
  if (!status.authenticated) throw new Error("Codex subscription authentication is required before activation.");
  return { route: engine.activateCodexSubscription({ model: body.model, ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}), ...(body.requestTimeoutMs ? { requestTimeoutMs: body.requestTimeoutMs } : {}) }) };
});
app.delete("/v1/model-auth/codex", async (request, reply) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  await engine.codexAuth.logout(tenantId);
  return await reply.code(204).send();
});

app.get("/v1/model-oauth-sources", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { sources: await engine.modelOAuth.list(tenantId) };
});
app.post("/v1/model-oauth-sources", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"), name: z.string().min(1).max(200), issuer: z.string().url(),
    clientId: z.string().min(1).max(500), clientSecretId: z.string().optional(),
    clientAuthMethod: z.enum(["none", "client_secret_basic", "client_secret_post"]).optional(),
    scopes: z.array(z.string().min(1).max(200)).min(1).max(50),
    authorizationServerOrigins: z.array(z.string().url()).max(20).optional(),
    resourceOrigins: z.array(z.string().url()).min(1).max(20),
    authorizeParameters: z.record(z.string(), z.string()).optional(),
  }).parse(request.body);
  return await reply.code(201).send(await engine.modelOAuth.register({
    tenantId: body.tenantId, name: body.name, issuer: body.issuer, clientId: body.clientId,
    ...(body.clientSecretId ? { clientSecretId: body.clientSecretId } : {}),
    ...(body.clientAuthMethod ? { clientAuthMethod: body.clientAuthMethod } : {}),
    scopes: body.scopes,
    ...(body.authorizationServerOrigins ? { authorizationServerOrigins: body.authorizationServerOrigins } : {}),
    resourceOrigins: body.resourceOrigins,
    ...(body.authorizeParameters ? { authorizeParameters: body.authorizeParameters } : {}),
  }));
});
app.patch("/v1/model-oauth-sources/:sourceId", async (request) => {
  const { sourceId } = z.object({ sourceId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), enabled: z.boolean() }).parse(request.body);
  return await engine.modelOAuth.setEnabled(sourceId, body.tenantId, body.enabled);
});
app.post("/v1/model-oauth-sources/:sourceId/start", async (request, reply) => {
  const { sourceId } = z.object({ sourceId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), returnTo: z.string().max(2000).default("/canvas/") }).parse(request.body ?? {});
  return await reply.code(201).send(await engine.modelOAuth.start(sourceId, body.tenantId, body.returnTo));
});
app.post("/v1/model-oauth-sources/:sourceId/logout", async (request) => {
  const { sourceId } = z.object({ sourceId: z.string().uuid() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.body ?? {});
  return await engine.modelOAuth.logout(sourceId, tenantId);
});
app.delete("/v1/model-oauth-sources/:sourceId", async (request, reply) => {
  const { sourceId } = z.object({ sourceId: z.string().uuid() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return await engine.modelOAuth.remove(sourceId, tenantId) ? await reply.code(204).send() : await reply.code(404).send({ error: "model_oauth_source_not_found" });
});

app.get("/v1/model-configurations", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().optional() }).parse(request.query);
  return { configurations: await engine.modelConfigurations.list(tenantId) };
});
app.post("/v1/model-configurations", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    name: z.string().min(1).max(200),
    baseProfileId: z.string().min(1),
    model: z.string().min(1).max(300),
    dataPolicy: z.enum(["provider", "aggregator", "local"]).optional(),
    baseUrl: z.string().url().optional(),
    credentialEnvironmentVariable: z.string().regex(/^[A-Z_][A-Z0-9_]{0,199}$/).optional(),
    credentialOAuthSourceId: z.string().uuid().optional(),
    credentialAudienceOrigin: z.string().url().optional(),
    headerEnvironmentVariables: z.record(z.string(), z.string()).optional(),
  }).parse(request.body);
  const configuration = await engine.modelConfigurations.add({
    tenantId: body.tenantId,
    name: body.name,
    baseProfileId: body.baseProfileId,
    model: body.model,
    ...(body.dataPolicy ? { dataPolicy: body.dataPolicy } : {}),
    ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
    ...(body.credentialEnvironmentVariable ? { credentialEnvironmentVariable: body.credentialEnvironmentVariable } : {}),
    ...(body.credentialOAuthSourceId ? { credentialOAuthSourceId: body.credentialOAuthSourceId } : {}),
    ...(body.credentialAudienceOrigin ? { credentialAudienceOrigin: body.credentialAudienceOrigin } : {}),
    ...(body.headerEnvironmentVariables ? { headerEnvironmentVariables: body.headerEnvironmentVariables } : {}),
  });
  if (configuration.configured) await engine.activateModelConfiguration(configuration.id);
  return await reply.code(201).send({ configuration, route: `${configuration.id}:${configuration.model}` });
});
app.patch("/v1/model-configurations/:configurationId", async (request) => {
  const { configurationId } = z.object({ configurationId: z.string() }).parse(request.params);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
  return await engine.setModelConfigurationEnabled(configurationId, enabled);
});
app.delete("/v1/model-configurations/:configurationId", async (request, reply) => {
  const { configurationId } = z.object({ configurationId: z.string() }).parse(request.params);
  const removed = await engine.removeModelConfiguration(configurationId);
  return removed ? await reply.code(204).send() : await reply.code(404).send({ error: "model_configuration_not_found" });
});

app.get("/v1/secret-sources", async () => ({ sources: await engine.secretSources.list() }));
app.post("/v1/secret-sources", async (request, reply) => {
  const body = z.object({
    name: z.string().min(1).max(200),
    kind: z.enum(["command", "onepassword", "bitwarden"]),
    executable: z.string().min(1),
    executableSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    args: z.array(z.string()).max(100).optional(),
    environmentVariables: z.array(z.string()).max(100).optional(),
    items: z.array(z.object({ secretName: z.string(), reference: z.string(), description: z.string().max(500).optional() })).min(1).max(200),
  }).parse(request.body);
  return await reply.code(201).send(await engine.secretSources.add({
    name: body.name, kind: body.kind, executable: body.executable, executableSha256: body.executableSha256,
    ...(body.args ? { args: body.args } : {}),
    ...(body.environmentVariables ? { environmentVariables: body.environmentVariables } : {}),
    items: body.items.map((item) => ({ secretName: item.secretName, reference: item.reference, ...(item.description ? { description: item.description } : {}) })),
  }));
});
app.patch("/v1/secret-sources/:sourceId", async (request) => {
  const { sourceId } = z.object({ sourceId: z.string() }).parse(request.params);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
  return await engine.secretSources.setEnabled(sourceId, enabled);
});
app.post("/v1/secret-sources/:sourceId/refresh", async (request) => {
  const { sourceId } = z.object({ sourceId: z.string() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.body ?? {});
  return await engine.secretSources.refresh(sourceId, tenantId);
});
app.delete("/v1/secret-sources/:sourceId", async (request, reply) => {
  const { sourceId } = z.object({ sourceId: z.string() }).parse(request.params);
  return await engine.secretSources.remove(sourceId) ? await reply.code(204).send() : await reply.code(404).send({ error: "secret_source_not_found" });
});

app.get("/v1/memory/providers/status", async () => await engine.externalMemory.status());

app.get("/v1/secrets", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { persistentAcrossRestart: engine.credentials.persistentAcrossRestart, secrets: await engine.credentials.list(tenantId) };
});
app.post("/v1/secrets", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    name: z.string(),
    value: z.string().min(1),
    description: z.string().max(500).optional(),
  }).parse(request.body);
  const metadata = await engine.credentials.put({
    tenantId: body.tenantId,
    name: body.name,
    value: body.value,
    ...(body.description ? { description: body.description } : {}),
  });
  return await reply.code(201).send(metadata);
});
app.delete("/v1/secrets/:secretId", async (request, reply) => {
  const { secretId } = z.object({ secretId: z.string() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  const removed = await engine.credentials.remove(tenantId, secretId);
  return removed ? await reply.code(204).send() : await reply.code(404).send({ error: "secret_not_found" });
});

app.get("/v1/backends", async () => ({ backends: await engine.backends.list() }));
app.post("/v1/backends", async (request, reply) => {
  const authSchema = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("none") }),
    z.object({ mode: z.literal("bearer-env"), environmentVariable: z.string() }),
    z.object({ mode: z.literal("session-key-env"), environmentVariable: z.string() }),
  ]);
  const body = z.object({
    name: z.string().min(1),
    kind: z.enum(["remote", "cloud"]),
    baseUrl: z.string().url(),
    auth: authSchema,
  }).parse(request.body);
  return await reply.code(201).send(await engine.backends.add(body));
});
app.get("/v1/backends/:backendId/health", async (request) => {
  const { backendId } = z.object({ backendId: z.string() }).parse(request.params);
  return await engine.backends.health(backendId);
});
app.patch("/v1/backends/:backendId", async (request) => {
  const { backendId } = z.object({ backendId: z.string() }).parse(request.params);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
  return await engine.backends.setEnabled(backendId, enabled);
});
app.delete("/v1/backends/:backendId", async (request, reply) => {
  const { backendId } = z.object({ backendId: z.string() }).parse(request.params);
  const removed = await engine.backends.remove(backendId);
  return removed ? await reply.code(204).send() : await reply.code(404).send({ error: "backend_not_found" });
});

function requiredExternalIdempotency(request: any): string {
  const value = request.headers["x-idempotency-key"];
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{8,200}$/.test(value)) throw new Error("x-idempotency-key is required for hosted review mutations.");
  return value;
}

app.get("/v1/github-apps", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { apps: await engine.githubApps.list(tenantId) };
});
app.post("/v1/github-apps", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"), name: z.string().min(1).max(200),
    appId: z.string().regex(/^\d{1,30}$/), clientId: z.string().regex(/^[A-Za-z0-9_.-]{5,200}$/).optional(),
    appSlug: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    privateKeySecretIds: z.array(z.string().min(8).max(200)).min(1).max(25),
    webhookSecretIds: z.array(z.string().min(8).max(200)).max(25).optional(),
    apiBase: z.string().url().optional(), webBase: z.string().url().optional(),
  }).parse(request.body);
  return await reply.code(201).send(await engine.githubApps.register({
    tenantId: body.tenantId, name: body.name, appId: body.appId, appSlug: body.appSlug,
    privateKeySecretIds: body.privateKeySecretIds,
    ...(body.clientId ? { clientId: body.clientId } : {}),
    ...(body.webhookSecretIds ? { webhookSecretIds: body.webhookSecretIds } : {}),
    ...(body.apiBase ? { apiBase: body.apiBase } : {}), ...(body.webBase ? { webBase: body.webBase } : {}),
  }));
});
app.patch("/v1/github-apps/:appConfigId", async (request) => {
  const { appConfigId } = z.object({ appConfigId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), enabled: z.boolean() }).parse(request.body);
  return await engine.githubApps.setEnabled(appConfigId, body.tenantId, body.enabled);
});
app.post("/v1/github-apps/:appConfigId/private-keys", async (request, reply) => {
  const { appConfigId } = z.object({ appConfigId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), secretId: z.string().min(8).max(200), makePrimary: z.boolean().default(true) }).parse(request.body);
  return await reply.code(201).send(await engine.githubApps.rotatePrivateKey({ appConfigId, tenantId: body.tenantId, secretId: body.secretId, makePrimary: body.makePrimary }));
});
app.patch("/v1/github-apps/:appConfigId/private-keys/:keyId", async (request) => {
  const { appConfigId, keyId } = z.object({ appConfigId: z.string().uuid(), keyId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), enabled: z.boolean() }).parse(request.body);
  return await engine.githubApps.setPrivateKeyEnabled({ appConfigId, keyId, tenantId: body.tenantId, enabled: body.enabled });
});
app.post("/v1/github-apps/:appConfigId/webhook-secrets", async (request, reply) => {
  const { appConfigId } = z.object({ appConfigId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), secretId: z.string().min(8).max(200), makePrimary: z.boolean().default(true) }).parse(request.body);
  return await reply.code(201).send(await engine.githubApps.rotateWebhookSecret({ appConfigId, tenantId: body.tenantId, secretId: body.secretId, makePrimary: body.makePrimary }));
});
app.patch("/v1/github-apps/:appConfigId/webhook-secrets/:keyId", async (request) => {
  const { appConfigId, keyId } = z.object({ appConfigId: z.string().uuid(), keyId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), enabled: z.boolean() }).parse(request.body);
  return await engine.githubApps.setWebhookSecretEnabled({ appConfigId, keyId, tenantId: body.tenantId, enabled: body.enabled });
});
app.post("/v1/github-apps/:appConfigId/installations/start", async (request, reply) => {
  const { appConfigId } = z.object({ appConfigId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), returnTo: z.string().max(2000).default("/canvas/") }).parse(request.body ?? {});
  return await reply.code(201).send(await engine.githubApps.startInstallation({ appConfigId, tenantId: body.tenantId, returnTo: body.returnTo }));
});
app.get("/v1/github-apps/installations", async (request) => {
  const query = z.object({ tenantId: z.string().default("local"), appConfigId: z.string().uuid().optional() }).parse(request.query);
  return { installations: await engine.githubApps.installations(query.tenantId, query.appConfigId) };
});
app.patch("/v1/github-apps/installations/:installationId", async (request) => {
  const { installationId } = z.object({ installationId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), enabled: z.boolean() }).parse(request.body);
  return await engine.githubApps.setInstallationEnabled(installationId, body.tenantId, body.enabled);
});
app.delete("/v1/github-apps/installations/:installationId", async (request, reply) => {
  const { installationId } = z.object({ installationId: z.string().uuid() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return await engine.githubApps.removeInstallation(installationId, tenantId)
    ? await reply.code(204).send()
    : await reply.code(404).send({ error: "github_app_installation_not_found" });
});
app.get("/v1/github-apps/events", async (request) => {
  const query = z.object({ tenantId: z.string().default("local"), appConfigId: z.string().uuid().optional() }).parse(request.query);
  return { events: await engine.githubApps.webhookEvents(query.tenantId, query.appConfigId) };
});

app.get("/v1/repository-providers", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { providers: await engine.hostedRepositories.list(tenantId) };
});
app.post("/v1/repository-providers", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    name: z.string().min(1).max(200),
    kind: z.enum(["github", "gitlab"]),
    credentialSecretId: z.string().min(1).optional(),
    githubAppInstallationId: z.string().uuid().optional(),
    apiBase: z.string().url().optional(),
    cloneOrigin: z.string().url().optional(),
    authStyle: z.enum(["bearer", "private-token"]).optional(),
    githubAccountMode: z.enum(["user", "installation"]).optional(),
  }).parse(request.body);
  return await reply.code(201).send(await engine.hostedRepositories.add({
    tenantId: body.tenantId, name: body.name, kind: body.kind,
    ...(body.credentialSecretId ? { credentialSecretId: body.credentialSecretId } : {}),
    ...(body.githubAppInstallationId ? { githubAppInstallationId: body.githubAppInstallationId } : {}),
    ...(body.apiBase ? { apiBase: body.apiBase } : {}),
    ...(body.cloneOrigin ? { cloneOrigin: body.cloneOrigin } : {}),
    ...(body.authStyle ? { authStyle: body.authStyle } : {}),
    ...(body.githubAccountMode ? { githubAccountMode: body.githubAccountMode } : {}),
  }));
});
app.patch("/v1/repository-providers/:providerId", async (request) => {
  const { providerId } = z.object({ providerId: z.string() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), enabled: z.boolean() }).parse(request.body);
  return await engine.hostedRepositories.setEnabled(providerId, body.tenantId, body.enabled);
});
app.delete("/v1/repository-providers/:providerId", async (request, reply) => {
  const { providerId } = z.object({ providerId: z.string() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return await engine.hostedRepositories.remove(providerId, tenantId)
    ? await reply.code(204).send()
    : await reply.code(404).send({ error: "repository_provider_not_found" });
});
app.get("/v1/repository-providers/:providerId/repositories", async (request) => {
  const { providerId } = z.object({ providerId: z.string() }).parse(request.params);
  const query = z.object({ tenantId: z.string().default("local"), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(request.query);
  return { repositories: await engine.hostedRepositories.repositories(providerId, query.tenantId, query.limit) };
});
app.get("/v1/repository-providers/:providerId/repositories/:repositoryId/reviews", async (request) => {
  const { providerId, repositoryId } = z.object({ providerId: z.string(), repositoryId: z.string() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { reviews: await engine.hostedRepositories.reviews(providerId, tenantId, repositoryId) };
});
app.post("/v1/repository-providers/:providerId/repositories/:repositoryId/reviews", async (request) => {
  const { providerId, repositoryId } = z.object({ providerId: z.string(), repositoryId: z.string() }).parse(request.params);
  const body = z.object({ sessionId: z.string(), title: z.string().min(1).max(300), body: z.string().max(100_000).optional(), sourceBranch: z.string().min(1).max(200), targetBranch: z.string().min(1).max(200), draft: z.boolean().default(false) }).parse(request.body);
  return await executeSessionCapability(body.sessionId, "repository.review.create", {
    providerId, repositoryId, title: body.title, sourceBranch: body.sourceBranch, targetBranch: body.targetBranch, draft: body.draft,
    ...(body.body ? { body: body.body } : {}),
  }, "web", requiredExternalIdempotency(request));
});
app.post("/v1/repository-providers/:providerId/repositories/:repositoryId/reviews/:reviewNumber/comments", async (request) => {
  const { providerId, repositoryId, reviewNumber } = z.object({ providerId: z.string(), repositoryId: z.string(), reviewNumber: z.coerce.number().int().positive() }).parse(request.params);
  const body = z.object({ sessionId: z.string(), body: z.string().min(1).max(100_000) }).parse(request.body);
  return await executeSessionCapability(body.sessionId, "repository.review.comment", { providerId, repositoryId, reviewNumber, body: body.body }, "web", requiredExternalIdempotency(request));
});
app.post("/v1/repository-providers/:providerId/repositories/:repositoryId/reviews/:reviewNumber/close", async (request) => {
  const { providerId, repositoryId, reviewNumber } = z.object({ providerId: z.string(), repositoryId: z.string(), reviewNumber: z.coerce.number().int().positive() }).parse(request.params);
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.body);
  return await executeSessionCapability(sessionId, "repository.review.close", { providerId, repositoryId, reviewNumber }, "web", requiredExternalIdempotency(request));
});
app.post("/v1/repository-providers/:providerId/repositories/:repositoryId/reviews/:reviewNumber/merge", async (request) => {
  const { providerId, repositoryId, reviewNumber } = z.object({ providerId: z.string(), repositoryId: z.string(), reviewNumber: z.coerce.number().int().positive() }).parse(request.params);
  const body = z.object({ sessionId: z.string(), expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i), method: z.enum(["merge", "squash", "rebase"]).default("merge") }).parse(request.body);
  return await executeSessionCapability(body.sessionId, "repository.review.merge", { providerId, repositoryId, reviewNumber, expectedHeadSha: body.expectedHeadSha, method: body.method }, "web", requiredExternalIdempotency(request));
});
app.get("/v1/repository-providers/:providerId/operations", async (request) => {
  const { providerId } = z.object({ providerId: z.string() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { operations: await engine.hostedRepositories.listOperations(tenantId, providerId) };
});

app.post("/v1/repository-providers/:providerId/import", async (request, reply) => {
  const { providerId } = z.object({ providerId: z.string() }).parse(request.params);
  const body = z.object({
    tenantId: z.string().default("local"), repositoryId: z.string().min(1), branch: z.string().max(200).optional(),
    name: z.string().min(1).max(200).optional(), agentProfileId: z.string().optional(),
  }).parse(request.body);
  return await reply.code(201).send(await engine.importHostedRepository({
    providerId, tenantId: body.tenantId, repositoryId: body.repositoryId,
    ...(body.branch ? { branch: body.branch } : {}),
    ...(body.name ? { name: body.name } : {}),
    ...(body.agentProfileId ? { agentProfileId: body.agentProfileId } : {}),
  }));
});
app.get("/v1/sessions/:sessionId/repository-sync", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const session = await engine.session(sessionId);
  return await engine.hostedRepositories.syncStatus(sessionId, session.tenantId, session.workspacePath);
});

app.post("/v1/repositories/import", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    url: z.string().url(),
    branch: z.string().max(200).optional(),
    credentialSecretId: z.string().optional(),
    credentialUsername: z.string().max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    agentProfileId: z.string().optional(),
  }).parse(request.body);
  return await reply.code(201).send(await engine.importRepository({
    tenantId: body.tenantId,
    url: body.url,
    ...(body.branch ? { branch: body.branch } : {}),
    ...(body.credentialSecretId ? { credentialSecretId: body.credentialSecretId } : {}),
    ...(body.credentialUsername ? { credentialUsername: body.credentialUsername } : {}),
    ...(body.name ? { name: body.name } : {}),
    ...(body.agentProfileId ? { agentProfileId: body.agentProfileId } : {}),
  }));
});

function publicSessionSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  const value = structuredClone(snapshot);
  value.messages = value.messages.filter((message) => !message.hidden);
  if (value.tree) {
    const original = value.tree.entries;
    const byId = new Map(original.map((entry) => [entry.id, entry]));
    const visible = original.filter((entry) => !entry.message.hidden);
    for (const entry of visible) {
      let parentId = entry.parentId;
      while (parentId && byId.get(parentId)?.message.hidden) parentId = byId.get(parentId)?.parentId;
      if (parentId) entry.parentId = parentId; else delete entry.parentId;
    }
    value.tree.entries = visible;
    if (value.tree.activeLeafId && !visible.some((entry) => entry.id === value.tree!.activeLeafId)) {
      let active = byId.get(value.tree.activeLeafId)?.parentId;
      while (active && byId.get(active)?.message.hidden) active = byId.get(active)?.parentId;
      const fallback = active ?? visible.at(-1)?.id;
      if (fallback) value.tree.activeLeafId = fallback; else delete value.tree.activeLeafId;
    }
  }
  return value;
}

const createSessionSchema = z.object({
  tenantId: z.string().min(1).default("local"),
  name: z.string().min(1).max(200).optional(),
  workspacePath: z.string().optional(),
  agentProfileId: z.string().optional(),
});
app.post("/v1/sessions", async (request, reply) => {
  const body = createSessionSchema.parse(request.body ?? {});
  const session = await engine.createSession({
    tenantId: body.tenantId,
    ...(body.name ? { name: body.name } : {}),
    ...(body.workspacePath ? { workspacePath: body.workspacePath } : {}),
    ...(body.agentProfileId ? { agentProfileId: body.agentProfileId } : {}),
  });
  return await reply.code(201).send(publicSessionSnapshot(session));
});

app.get("/v1/knowledge/search", async (request) => {
  const query = z.object({
    tenantId: z.string().default("local"),
    q: z.string().min(1),
    kinds: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }).parse(request.query);
  const kinds = query.kinds?.split(",").filter((kind): kind is "session_message" | "memory" | "skill" | "artifact" =>
    ["session_message", "memory", "skill", "artifact"].includes(kind));
  return { hits: await engine.knowledgeIndex.search({ tenantId: query.tenantId, query: query.q, ...(kinds?.length ? { kinds } : {}), limit: query.limit }) };
});
app.post("/v1/knowledge/reindex", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.body ?? {});
  let indexed = 0;
  for (const session of await engine.sessions(tenantId)) indexed += await engine.knowledgeIndexer.indexSession(session);
  return { indexed, total: await engine.knowledgeIndex.count(tenantId) };
});

app.get("/v1/session-search", async (request) => {
  const query = z.object({
    tenantId: z.string().default("local"),
    q: z.string().min(1),
    limit: z.coerce.number().int().positive().max(50).default(20),
  }).parse(request.query);
  return { hits: await engine.sessionSearch.search(query.tenantId, query.q, query.limit) };
});

app.get("/v1/sessions", async (request) => {
  const query = z.object({ tenantId: z.string().optional() }).parse(request.query);
  return { sessions: (await engine.sessions(query.tenantId)).map(publicSessionSnapshot) };
});

app.get("/v1/sessions/:sessionId", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  return publicSessionSnapshot(await engine.session(sessionId));
});

app.get("/v1/sessions/:sessionId/roster", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  return { currentSessionId: sessionId, agents: await engine.supervisor.familyRoster(sessionId) };
});

app.get("/v1/sessions/:sessionId/inbox", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const { states } = z.object({ states: z.string().optional() }).parse(request.query);
  const parsedStates = states?.split(",").filter((state): state is "pending" | "claimed" | "delivered" | "uncertain" =>
    ["pending", "claimed", "delivered", "uncertain"].includes(state));
  return { messages: await engine.supervisor.listAgentInbox(sessionId, parsedStates?.length ? parsedStates : undefined) };
});

app.post("/v1/sessions/:sessionId/messages", async (request, reply) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({
    message: z.string().min(1).max(16_384),
    mode: z.enum(["auto", "steer", "follow_up"]).default("auto"),
    targetSessionId: z.string().optional(),
    receiverRole: z.enum(["parent", "sibling", "child"]).optional(),
    receiverName: z.string().min(1).max(200).optional(),
    broadcast: z.boolean().default(false),
  }).parse(request.body);
  const result = await engine.supervisor.sendAgentMessage({
    senderSessionId: sessionId,
    message: body.message,
    mode: body.mode,
    ...(body.targetSessionId ? { targetSessionId: body.targetSessionId } : {}),
    ...(body.receiverRole ? { receiverRole: body.receiverRole } : {}),
    ...(body.receiverName ? { receiverName: body.receiverName } : {}),
    broadcast: body.broadcast,
  });
  return await reply.code(result.receipts.every((receipt) => receipt.deliveryStatus === "delivered") ? 200 : 202).send(result);
});

app.get("/v1/sessions/:sessionId/export", async (request, reply) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const { format } = z.object({ format: z.enum(["json", "markdown", "trajectory"]).default("markdown") }).parse(request.query);
  const session = await engine.session(sessionId);
  const safeName = session.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "session";
  if (format === "trajectory") {
    return await reply
      .header("content-disposition", `attachment; filename="${safeName}-${session.sessionId.slice(0, 8)}.trajectory.json"`)
      .type("application/json; charset=utf-8")
      .send(transcriptAsTrajectory(session));
  }
  if (format === "json") {
    return await reply
      .header("content-disposition", `attachment; filename="${safeName}-${session.sessionId.slice(0, 8)}.json"`)
      .type("application/json; charset=utf-8")
      .send(transcriptAsJson(session));
  }
  return await reply
    .header("content-disposition", `attachment; filename="${safeName}-${session.sessionId.slice(0, 8)}.md"`)
    .type("text/markdown; charset=utf-8")
    .send(transcriptAsMarkdown(session));
});

app.post("/v1/sessions/:sessionId/fork", async (request, reply) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({
    messageId: z.string().optional(),
    name: z.string().min(1).max(200).optional(),
    includeAbandonedBranchSummary: z.boolean().default(false),
  }).parse(request.body ?? {});
  const forked = await engine.supervisor.forkSession({
    sourceSessionId: sessionId,
    ...(body.messageId ? { messageId: body.messageId } : {}),
    ...(body.name ? { name: body.name } : {}),
    includeAbandonedBranchSummary: body.includeAbandonedBranchSummary,
  });
  return await reply.code(201).send(forked);
});

const commandBodySchema = z.object({
  commandId: z.string().optional(),
  clientId: z.string().default("control-api"),
  tenantId: z.string().default("local"),
  expectedGeneration: z.number().int().nonnegative().optional(),
  kind: z.enum([
    "session.prompt", "session.cancel", "session.pause", "session.resume", "session.close", "session.compact",
    "session.tree.get", "session.tree.branch", "session.tree.label",
    "goal.set", "goal.pause", "goal.resume", "goal.complete", "goal.clear", "autonomous.configure", "model.select", "agent.message",
    "task.list", "task.create", "task.update",
  ]),
  source: z.enum(["web", "cli", "api", "scheduler", "agent", "telegram", "discord", "slack", "webhook"]).default("api"),
  payload: z.unknown().default({}),
});
app.post("/v1/sessions/:sessionId/commands", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = commandBodySchema.parse(request.body ?? {});
  const raw = {
    protocolVersion: 1,
    commandId: body.commandId ?? randomUUID(),
    clientId: body.clientId,
    tenantId: body.tenantId,
    sessionId,
    ...(body.expectedGeneration !== undefined ? { expectedGeneration: body.expectedGeneration } : {}),
    kind: body.kind,
    source: body.source,
    issuedAt: new Date().toISOString(),
    payload: body.payload,
  };
  const parsed = commandEnvelopeSchema.parse(raw);
  const result = await engine.command(parsed as CommandEnvelope);
  // A command refused because the session is closed or paused is not a
  // successful request. It used to answer 200 with the refusal buried in the
  // body, so a client polling for work could not distinguish "done" from "this
  // session will never accept anything again" without parsing prose.
  if (result.status === "rejected" && result.error?.code === "SESSION_NOT_RUNNABLE") {
    throw new AppError("SESSION_ALREADY_CLOSED", {
      sessionId,
      sessionState: result.error.sessionState,
      commandKind: body.kind,
    });
  }
  return result;
});

app.get("/v1/sessions/:sessionId/files", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const query = z.object({ path: z.string().default("."), maxEntries: z.coerce.number().int().positive().max(5000).default(1000) }).parse(request.query);
  return await executeSessionCapability(sessionId, "filesystem.list", query);
});
app.get("/v1/sessions/:sessionId/file", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const query = z.object({ path: z.string().min(1), maxChars: z.coerce.number().int().positive().max(1_000_000).default(300_000) }).parse(request.query);
  return await executeSessionCapability(sessionId, "filesystem.read", query);
});
app.put("/v1/sessions/:sessionId/file", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({ path: z.string().min(1), content: z.string().max(2_000_000) }).parse(request.body);
  return await executeSessionCapability(sessionId, "filesystem.write", body, "web", request.headers["x-idempotency-key"] as string | undefined);
});
app.post("/v1/sessions/:sessionId/attachments", async (request, reply) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200).default("application/octet-stream"),
    base64: z.string().min(1).max(3_900_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  }).parse(request.body);
  const safeName = body.fileName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "attachment.bin";
  const path = `.haf/uploads/${Date.now()}-${randomUUID()}-${safeName}`;
  const artifact = await executeSessionCapability(sessionId, "filesystem.write_binary", {
    path,
    base64: body.base64,
    ...(body.sha256 ? { expectedSha256: body.sha256 } : {}),
  }, "web", request.headers["x-idempotency-key"] as string | undefined);
  return await reply.code(201).send({ ...artifact as object, fileName: safeName, mimeType: body.mimeType });
});

app.get("/v1/sessions/:sessionId/artifacts", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const session = await engine.session(sessionId);
  return { artifacts: await engine.interactiveArtifacts.list(session.tenantId, sessionId) };
});
app.post("/v1/sessions/:sessionId/artifacts", async (request, reply) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const session = await engine.session(sessionId);
  const body = z.object({ name: z.string().min(1).max(200), sourcePath: z.string().min(1), allowedActions: z.array(z.string().min(1).max(100)).min(1).max(32) }).parse(request.body);
  return await reply.code(201).send(await engine.interactiveArtifacts.publish({
    tenantId: session.tenantId, sessionId, workspacePath: session.workspacePath,
    name: body.name, sourcePath: body.sourcePath, allowedActions: body.allowedActions,
  }));
});
app.post("/v1/artifacts/:artifactId/frame", async (request) => {
  const { artifactId } = z.object({ artifactId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), sessionId: z.string() }).parse(request.body);
  const artifact = await engine.interactiveArtifacts.get(artifactId, body.tenantId);
  if (artifact.sessionId !== body.sessionId) throw new Error("Artifact/session mismatch.");
  const grant = await engine.interactiveArtifacts.createFrame({ id: artifactId, tenantId: body.tenantId, sessionId: body.sessionId });
  return { ...grant, frameUrl: `/v1/artifacts/${artifactId}/frame?tenantId=${encodeURIComponent(body.tenantId)}&sessionId=${encodeURIComponent(body.sessionId)}&channel=${encodeURIComponent(grant.channel)}` };
});
app.get("/v1/artifacts/:artifactId/frame", async (request, reply) => {
  const { artifactId } = z.object({ artifactId: z.string().uuid() }).parse(request.params);
  const query = z.object({ tenantId: z.string().default("local"), sessionId: z.string(), channel: z.string() }).parse(request.query);
  const session = await engine.session(query.sessionId);
  if (session.tenantId !== query.tenantId) return await reply.code(403).send({ error: "tenant_mismatch" });
  const html = await engine.interactiveArtifacts.renderFrame({
    id: artifactId, tenantId: query.tenantId, sessionId: query.sessionId, workspacePath: session.workspacePath, channel: query.channel,
  });
  return await reply
    .header("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'; object-src 'none'; sandbox allow-scripts")
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(html);
});
app.post("/v1/artifacts/:artifactId/interactions", async (request, reply) => {
  const { artifactId } = z.object({ artifactId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    tenantId: z.string().default("local"), sessionId: z.string(), channel: z.string(),
    interactionId: z.string().min(8).max(200), action: z.string().min(1).max(100), payload: z.unknown().default(null),
  }).parse(request.body);
  const accepted = await engine.interactiveArtifacts.acceptInteraction({
    artifactId, tenantId: body.tenantId, sessionId: body.sessionId, channel: body.channel,
    interactionId: body.interactionId, action: body.action, payload: body.payload as JsonValue,
  });
  if (accepted.duplicate) return { ok: accepted.interaction.status === "delivered", duplicate: true, status: accepted.interaction.status };
  try {
    const result = await engine.command({
      protocolVersion: 1, commandId: `artifact:${artifactId}:${body.interactionId}`, clientId: `artifact:${artifactId}`,
      tenantId: body.tenantId, sessionId: body.sessionId, kind: "artifact.interaction", source: "web",
      issuedAt: new Date().toISOString(), payload: { text: accepted.prompt },
    });
    const finalText = typeof (result.result as any)?.finalText === "string" ? String((result.result as any).finalText) : "";
    const status = result.status === "completed" ? "delivered" : result.status === "uncertain" ? "uncertain" : "failed";
    await engine.interactiveArtifacts.completeInteraction(body.interactionId, body.tenantId, {
      status, ...(finalText ? { response: finalText } : {}), ...(result.error?.code ? { errorCode: result.error.code } : {}),
    });
    return await reply.code(result.status === "completed" ? 200 : result.status === "uncertain" ? 202 : 422).send({
      ok: result.status === "completed", status, result: finalText.slice(0, 100_000), ...(result.error ? { error: result.error.code } : {}),
    });
  } catch (error) {
    await engine.interactiveArtifacts.completeInteraction(body.interactionId, body.tenantId, { status: "failed", errorCode: "dispatch_failed" });
    throw error;
  }
});
app.get("/v1/sessions/:sessionId/artifact-interactions", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const session = await engine.session(sessionId);
  return { interactions: await engine.interactiveArtifacts.interactions(session.tenantId, sessionId) };
});
app.patch("/v1/artifacts/:artifactId", async (request) => {
  const { artifactId } = z.object({ artifactId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), enabled: z.boolean() }).parse(request.body);
  return await engine.interactiveArtifacts.setEnabled(artifactId, body.tenantId, body.enabled);
});
app.delete("/v1/artifacts/:artifactId", async (request, reply) => {
  const { artifactId } = z.object({ artifactId: z.string().uuid() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return await engine.interactiveArtifacts.remove(artifactId, tenantId) ? await reply.code(204).send() : await reply.code(404).send({ error: "artifact_not_found" });
});

app.post("/v1/sessions/:sessionId/terminal", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({ command: z.string().min(1).max(50_000), cwd: z.string().optional(), timeoutMs: z.number().int().positive().max(600_000).optional() }).parse(request.body);
  return await executeSessionCapability(sessionId, "process.exec", {
    command: body.command,
    ...(body.cwd ? { cwd: body.cwd } : {}),
    ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
    maxOutputChars: 500_000,
  }, "web", request.headers["x-idempotency-key"] as string | undefined);
});
app.get("/v1/sessions/:sessionId/changes", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const [status, diff] = await Promise.all([
    executeSessionCapability(sessionId, "git.status", {}),
    executeSessionCapability(sessionId, "git.diff", { staged: false }),
  ]) as [any, any];
  return { status: status.output, diff: diff.output, stdout: `${status.output}\n---DIFF---\n${diff.output}` };
});
app.get("/v1/sessions/:sessionId/git/branches", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  return await executeSessionCapability(sessionId, "git.branch.list", {});
});
app.post("/v1/sessions/:sessionId/git/branches", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({ name: z.string().min(1).max(200), startPoint: z.string().min(1).max(200).optional() }).parse(request.body);
  return await executeSessionCapability(sessionId, "git.branch.create", body, "web", request.headers["x-idempotency-key"] as string | undefined);
});
app.post("/v1/sessions/:sessionId/git/switch", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({ name: z.string().min(1).max(200) }).parse(request.body);
  return await executeSessionCapability(sessionId, "git.branch.switch", body, "web", request.headers["x-idempotency-key"] as string | undefined);
});
app.post("/v1/sessions/:sessionId/git/commit", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({
    message: z.string().min(1).max(10_000),
    paths: z.array(z.string().min(1).max(1000)).min(1).max(200),
    authorName: z.string().min(1).max(200).optional(),
    authorEmail: z.string().email().max(320).optional(),
  }).parse(request.body);
  return await executeSessionCapability(sessionId, "git.commit", body, "web", request.headers["x-idempotency-key"] as string | undefined);
});
app.post("/v1/sessions/:sessionId/channels/send", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({
    platform: z.string().min(1), destination: z.string().min(1), text: z.string().min(1).max(100_000),
    threadId: z.string().optional(), mediaPath: z.string().optional(),
  }).parse(request.body);
  return await executeSessionCapability(sessionId, "channel.send", body, "web", request.headers["x-idempotency-key"] as string | undefined);
});

app.post("/v1/sessions/:sessionId/media/video", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({
    prompt: z.string().min(1).max(20_000),
    aspectRatio: z.enum(["landscape", "square", "portrait"]).default("landscape"),
    durationSeconds: z.number().int().min(1).max(30).optional(),
    sourcePath: z.string().optional(),
    sourcePaths: z.array(z.string().min(1)).max(4).optional(),
    providerId: z.string().optional(),
  }).parse(request.body);
  return await executeSessionCapability(sessionId, "video.generate", body, "web", request.headers["x-idempotency-key"] as string | undefined);
});
app.post("/v1/sessions/:sessionId/media/video/upscale", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({ sourcePath: z.string().min(1), providerId: z.string().min(1), scale: z.union([z.literal(2), z.literal(4)]) }).parse(request.body);
  return await executeSessionCapability(sessionId, "video.upscale", body, "web", request.headers["x-idempotency-key"] as string | undefined);
});
app.post("/v1/sessions/:sessionId/media/video/jobs", async (request, reply) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const session = await engine.session(sessionId);
  const body = z.object({
    providerId: z.string().min(1), prompt: z.string().min(1).max(20_000),
    aspectRatio: z.enum(["landscape", "square", "portrait"]).default("landscape"),
    durationSeconds: z.number().int().min(1).max(30).optional(),
    sourcePath: z.string().optional(), sourcePaths: z.array(z.string().min(1)).max(4).optional(),
  }).parse(request.body);
  return await reply.code(202).send(await engine.mediaJobs.submitVideo({
    tenantId: session.tenantId, sessionId, workspacePath: session.workspacePath,
    providerId: body.providerId, prompt: body.prompt, aspectRatio: body.aspectRatio,
    ...(body.durationSeconds ? { durationSeconds: body.durationSeconds } : {}),
    ...(body.sourcePath ? { sourcePath: body.sourcePath } : {}),
    ...(body.sourcePaths?.length ? { sourcePaths: body.sourcePaths } : {}),
    idempotencyKey: typeof request.headers["x-idempotency-key"] === "string" ? request.headers["x-idempotency-key"] : randomUUID(),
  }));
});
app.get("/v1/media/jobs", async (request) => {
  const query = z.object({ tenantId: z.string().default("local"), sessionId: z.string().optional() }).parse(request.query);
  return { jobs: await engine.mediaJobs.list(query.tenantId, query.sessionId) };
});
app.get("/v1/media/jobs/:jobId", async (request) => {
  const { jobId } = z.object({ jobId: z.string().uuid() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return await engine.mediaJobs.get(jobId, tenantId);
});
app.post("/v1/media/jobs/:jobId/poll", async (request) => {
  const { jobId } = z.object({ jobId: z.string().uuid() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.body ?? {});
  const job = await engine.mediaJobs.get(jobId, tenantId);
  const session = await engine.session(job.sessionId);
  if (session.tenantId !== tenantId) throw new Error("Media job/session tenant mismatch.");
  return await engine.mediaJobs.poll({ id: jobId, tenantId, workspacePath: session.workspacePath });
});
app.post("/v1/media/jobs/:jobId/cancel", async (request) => {
  const { jobId } = z.object({ jobId: z.string().uuid() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.body ?? {});
  return await engine.mediaJobs.cancel({ id: jobId, tenantId });
});
app.post("/v1/sessions/:sessionId/media/image", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({
    prompt: z.string().min(1).max(20_000),
    aspectRatio: z.enum(["landscape", "square", "portrait"]).default("landscape"),
    count: z.number().int().min(1).max(4).default(1),
    sourcePath: z.string().optional(),
    sourcePaths: z.array(z.string().min(1)).max(8).optional(),
    upscale: z.object({ providerId: z.string().min(1), scale: z.union([z.literal(2), z.literal(4)]) }).optional(),
    providerId: z.string().optional(),
    model: z.string().optional(),
  }).parse(request.body);
  return await executeSessionCapability(sessionId, "image.generate", body, "web", request.headers["x-idempotency-key"] as string | undefined);
});
app.post("/v1/sessions/:sessionId/media/image/upscale", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.object({
    sourcePath: z.string().min(1), providerId: z.string().min(1), scale: z.union([z.literal(2), z.literal(4)]),
  }).parse(request.body);
  return await executeSessionCapability(sessionId, "image.upscale", body, "web", request.headers["x-idempotency-key"] as string | undefined);
});

app.post("/v1/sessions/:sessionId/browser", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const body = z.discriminatedUnion("action", [
    z.object({ action: z.literal("navigate"), url: z.string().url() }),
    z.object({ action: z.literal("snapshot") }),
    z.object({ action: z.literal("click"), ref: z.string() }),
    z.object({ action: z.literal("type"), ref: z.string(), text: z.string(), submit: z.boolean().default(false) }),
    z.object({ action: z.literal("press"), key: z.string() }),
  ]).parse(request.body);
  const mapping = { navigate: "browser.navigate", snapshot: "browser.snapshot", click: "browser.click", type: "browser.type", press: "browser.press" } as const;
  const { action, ...input } = body;
  return await executeSessionCapability(sessionId, mapping[action], input, "web", request.headers["x-idempotency-key"] as string | undefined);
});

app.get("/v1/sessions/:sessionId/events", async (request) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const query = z.object({ afterSequence: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().positive().max(5000).default(1000) }).parse(request.query);
  return { events: (await engine.readEvents(sessionId, query.afterSequence, query.limit)).filter((event) => event.visibility !== "internal") };
});

app.get("/v1/sessions/:sessionId/events/stream", async (request, reply) => {
  const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
  const query = z.object({ afterSequence: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event: any) => {
    if (event?.visibility === "internal") return;
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  for (const event of await engine.readEvents(sessionId, query.afterSequence, 5000)) send(event);
  const unsubscribe = engine.subscribe(sessionId, send);
  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    reply.raw.end();
  });
});

app.post("/v1/detached-workers", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    name: z.string().min(1).max(200).optional(),
  }).parse(request.body ?? {});
  const workerId = randomUUID();
  const client = await detachedWorkers.spawn({
    workerId,
    entrypoint: detachedWorkerEntrypoint,
    env: {
      HAF_WORKER_HOME: resolve(homePath, "detached", workerId),
      HAF_WORKER_TENANT_ID: body.tenantId,
      HAF_WORKER_SESSION_NAME: body.name ?? `detached-${workerId.slice(0, 8)}`,
    },
    startupTimeoutMs: 30_000,
  });
  const state = JSON.parse((await client.command("state")).toString("utf8"));
  return await reply.code(201).send({ workerId, state, cursor: client.cursor });
});

app.get("/v1/detached-workers", async () => {
  const adopted = await detachedWorkers.adoptAll(true);
  const workers = [];
  for (const item of adopted) {
    if (item.status === "stale" || !item.client) {
      workers.push({ workerId: item.workerId, status: "stale" });
      continue;
    }
    try {
      const state = JSON.parse((await item.client.command("state", Buffer.alloc(0), 5000)).toString("utf8"));
      workers.push({
        workerId: item.workerId,
        status: item.status === "recovered" ? "recovered" : "running",
        state,
        cursor: item.client.cursor,
      });
    } catch {
      workers.push({ workerId: item.workerId, status: "unreachable" });
    }
  }
  return { workers };
});

app.get("/v1/detached-workers/:workerId", async (request) => {
  const { workerId } = z.object({ workerId: z.string() }).parse(request.params);
  const client = await detachedWorkers.adopt(workerId);
  return {
    workerId,
    state: JSON.parse((await client.command("state")).toString("utf8")),
    cursor: client.cursor,
  };
});

app.post("/v1/detached-workers/:workerId/commands", async (request) => {
  const { workerId } = z.object({ workerId: z.string() }).parse(request.params);
  const body = commandBodySchema.parse(request.body ?? {});
  const raw = {
    protocolVersion: 1,
    commandId: body.commandId ?? randomUUID(),
    clientId: body.clientId,
    tenantId: body.tenantId,
    sessionId: workerId,
    ...(body.expectedGeneration !== undefined ? { expectedGeneration: body.expectedGeneration } : {}),
    kind: body.kind,
    source: body.source,
    issuedAt: new Date().toISOString(),
    payload: body.payload,
  };
  const command = commandEnvelopeSchema.parse(raw) as CommandEnvelope;
  const client = await detachedWorkers.adopt(workerId);
  return JSON.parse((await client.command("dispatch", command)).toString("utf8"));
});

app.get("/v1/detached-workers/:workerId/events/stream", async (request, reply) => {
  const { workerId } = z.object({ workerId: z.string() }).parse(request.params);
  const query = z.object({
    generation: z.coerce.number().int().nonnegative().default(0),
    sequence: z.coerce.number().int().nonnegative().default(0),
  }).parse(request.query);
  const client = await detachedWorkers.adopt(workerId);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  const unsubscribeEvent = client.onEvent((event) => {
    let payload: unknown = event.payload.toString("utf8");
    try { payload = JSON.parse(payload as string); } catch {}
    send({ type: event.eventType, cursor: event.cursor, payload });
  });
  const unsubscribeResync = client.onResyncRequired((cursor) => send({ type: "resync_required", cursor }));
  try {
    const attached = await client.attach({ generation: query.generation, sequence: query.sequence });
    send({
      type: "attached",
      replay: attached.replay,
      cursor: attached.cursor,
      ...(attached.snapshot ? { snapshot: JSON.parse(attached.snapshot.toString("utf8")) } : {}),
    });
  } catch (error) {
    send({ type: "attach_error", error: error instanceof Error ? error.message : String(error) });
  }
  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribeEvent();
    unsubscribeResync();
    reply.raw.end();
  });
});

app.get("/v1/detached-workers/:workerId/approvals", async (request) => {
  const { workerId } = z.object({ workerId: z.string() }).parse(request.params);
  const client = await detachedWorkers.adopt(workerId);
  return JSON.parse((await client.command("approvals_list")).toString("utf8"));
});
app.post("/v1/detached-workers/:workerId/approvals/:approvalId/resolve", async (request) => {
  const { workerId, approvalId } = z.object({ workerId: z.string(), approvalId: z.string() }).parse(request.params);
  const { decision } = z.object({ decision: z.enum(["approve_once", "approve_session", "deny"]) }).parse(request.body);
  const client = await detachedWorkers.adopt(workerId);
  return JSON.parse((await client.command("approval_resolve", { id: approvalId, decision })).toString("utf8"));
});
app.delete("/v1/detached-workers/:workerId", async (request, reply) => {
  const { workerId } = z.object({ workerId: z.string() }).parse(request.params);
  await detachedWorkers.stop(workerId);
  return await reply.code(204).send();
});

app.get("/v1/approvals", async (request) => {
  const query = z.object({ sessionId: z.string().optional() }).parse(request.query);
  return { approvals: engine.approvals.list(query.sessionId) };
});

app.post("/v1/approvals/:approvalId/resolve", async (request) => {
  const { approvalId } = z.object({ approvalId: z.string() }).parse(request.params);
  const { decision, resolvedBy } = z.object({ decision: z.enum(["approve_once", "approve_session", "deny"]), resolvedBy: z.string().min(1).max(200).optional() }).parse(request.body);
  return engine.approvals.resolve(approvalId, decision, resolvedBy);
});

const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().datetime() }),
  z.object({ kind: z.literal("interval"), everyMs: z.number().int().min(1000) }),
  z.object({ kind: z.literal("cron"), expression: z.string().min(1), timezone: z.string().optional() }),
]);
app.post("/v1/schedules", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    sessionId: z.string(),
    prompt: z.string().min(1),
    schedule: scheduleSchema,
    label: z.string().optional(),
  }).parse(request.body);
  const schedule = body.schedule.kind === "cron"
    ? { kind: "cron" as const, expression: body.schedule.expression, ...(body.schedule.timezone ? { timezone: body.schedule.timezone } : {}) }
    : body.schedule;
  return await reply.code(201).send(await engine.schedule({
    tenantId: body.tenantId,
    sessionId: body.sessionId,
    prompt: body.prompt,
    schedule,
    ...(body.label ? { label: body.label } : {}),
  }));
});

app.get("/v1/schedules", async (request) => {
  const query = z.object({ tenantId: z.string().optional() }).parse(request.query);
  return { jobs: await engine.scheduler.list(query.tenantId) };
});

app.post("/v1/schedules/:jobId/status", async (request) => {
  const { jobId } = z.object({ jobId: z.string() }).parse(request.params);
  const { status } = z.object({ status: z.enum(["active", "paused", "cancelled"]) }).parse(request.body);
  return await engine.scheduler.setStatus(jobId, status);
});

app.post("/v1/cron/fire", async (request, reply) => {
  if (!engine.hostedScheduler) return await reply.code(503).send({ error: "hosted_scheduler_not_configured" });
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return await reply.code(401).send({ error: "missing_cron_fire_token" });
  const body = z.object({ job_id: z.string(), fire_at: z.string().datetime() }).parse(request.body);
  const claims = await engine.hostedScheduler.verifyFire(token);
  if (claims.jobId !== body.job_id || claims.fireAt !== body.fire_at) return await reply.code(401).send({ error: "cron_fire_claim_mismatch" });
  void engine.hostedScheduler.handleFire(token, body, engine.scheduler).catch((error) => {
    app.log.error({ errorClass: error instanceof Error ? error.name : "unknown" }, "hosted cron fire failed");
  });
  return await reply.code(202).send({ status: "accepted", jobId: body.job_id });
});

const automationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("schedule"), schedule: scheduleSchema }),
  z.object({ kind: z.literal("webhook"), eventType: z.string().min(1), secretEnvironmentVariable: z.string().optional() }),
]);
app.get("/v1/automation-responders", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { responders: await engine.automationResponders.list(tenantId) };
});
app.post("/v1/automation-responders", async (request, reply) => {
  const body = z.object({ tenantId: z.string().default("local"), name: z.string().min(1).max(200), automationId: z.string().uuid(), credentialSecretId: z.string().min(1), heartbeatIntervalMs: z.number().int().min(10_000).max(3_600_000).optional() }).parse(request.body);
  return await reply.code(201).send(await engine.automationResponders.add({ tenantId: body.tenantId, name: body.name, automationId: body.automationId, credentialSecretId: body.credentialSecretId, ...(body.heartbeatIntervalMs ? { heartbeatIntervalMs: body.heartbeatIntervalMs } : {}) }));
});
app.patch("/v1/automation-responders/:responderId", async (request) => {
  const { responderId } = z.object({ responderId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), enabled: z.boolean() }).parse(request.body);
  return await engine.automationResponders.setEnabled(responderId, body.tenantId, body.enabled);
});
app.post("/v1/automation-responders/:responderId/credential", async (request) => {
  const { responderId } = z.object({ responderId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), credentialSecretId: z.string().min(1) }).parse(request.body);
  return await engine.automationResponders.rotateCredential(responderId, body.tenantId, body.credentialSecretId);
});
app.delete("/v1/automation-responders/:responderId", async (request, reply) => {
  const { responderId } = z.object({ responderId: z.string().uuid() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return await engine.automationResponders.remove(responderId, tenantId) ? await reply.code(204).send() : await reply.code(404).send({ error: "automation_responder_not_found" });
});
function responderHeaders(request: any) {
  const timestamp = request.headers["x-haf-responder-timestamp"] as string | undefined;
  const nonce = request.headers["x-haf-responder-nonce"] as string | undefined;
  const signature = request.headers["x-haf-responder-signature"] as string | undefined;
  return { ...(timestamp ? { timestamp } : {}), ...(nonce ? { nonce } : {}), ...(signature ? { signature } : {}) };
}
app.post("/v1/automation-responders/:responderId/heartbeat", async (request, reply) => {
  const { responderId } = z.object({ responderId: z.string().uuid() }).parse(request.params);
  const raw = (request as any).rawBody as Buffer | undefined;
  if (!raw) throw new Error("Automation responder raw body is unavailable.");
  try { return await engine.automationResponders.acceptHeartbeat(responderId, raw, responderHeaders(request), request.body); }
  catch { return await reply.code(401).send({ accepted: false, error: "automation_responder_verification_failed" }); }
});
app.post("/v1/automation-responders/:responderId/events", async (request, reply) => {
  const { responderId } = z.object({ responderId: z.string().uuid() }).parse(request.params);
  const raw = (request as any).rawBody as Buffer | undefined;
  if (!raw) throw new Error("Automation responder raw body is unavailable.");
  try { return await reply.code(202).send(await engine.automationResponders.acceptEvent(responderId, raw, responderHeaders(request), request.body)); }
  catch { return await reply.code(401).send({ accepted: false, error: "automation_responder_verification_failed" }); }
});

app.get("/v1/automation-git-sources", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { sources: await engine.automationGitSync.list(tenantId) };
});
app.post("/v1/automation-git-sources", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"), name: z.string().min(1).max(200),
    providerId: z.string().min(1), repositoryId: z.string().min(1),
    manifestPath: z.string().min(1).max(500), ref: z.string().min(1).max(200), sessionId: z.string().min(1),
    webhookSecretEnvironmentVariable: z.string().regex(/^[A-Z_][A-Z0-9_]{0,199}$/).optional(),
    allowedModels: z.array(z.string().min(1).max(300)).max(20).optional(),
  }).parse(request.body);
  return await reply.code(201).send(await engine.automationGitSync.add({
    tenantId: body.tenantId, name: body.name, providerId: body.providerId,
    repositoryId: body.repositoryId, manifestPath: body.manifestPath, ref: body.ref, sessionId: body.sessionId,
    ...(body.webhookSecretEnvironmentVariable ? { webhookSecretEnvironmentVariable: body.webhookSecretEnvironmentVariable } : {}),
    ...(body.allowedModels ? { allowedModels: body.allowedModels } : {}),
  }));
});
app.patch("/v1/automation-git-sources/:sourceId", async (request) => {
  const { sourceId } = z.object({ sourceId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), enabled: z.boolean() }).parse(request.body);
  return await engine.automationGitSync.setEnabled(sourceId, body.tenantId, body.enabled);
});
app.delete("/v1/automation-git-sources/:sourceId", async (request, reply) => {
  const { sourceId } = z.object({ sourceId: z.string().uuid() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return await engine.automationGitSync.remove(sourceId, tenantId)
    ? await reply.code(204).send()
    : await reply.code(404).send({ error: "automation_git_source_not_found" });
});
app.post("/v1/automation-git-sources/:sourceId/plan", async (request) => {
  const { sourceId } = z.object({ sourceId: z.string().uuid() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.body ?? {});
  return await engine.automationGitSync.plan(sourceId, tenantId);
});
app.post("/v1/automation-git-sources/:sourceId/apply", async (request) => {
  const { sourceId } = z.object({ sourceId: z.string().uuid() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), expectedManifestSha256: z.string().regex(/^[a-f0-9]{64}$/i) }).parse(request.body);
  return await engine.automationGitSync.apply(sourceId, body.tenantId, body.expectedManifestSha256);
});

app.get("/v1/automations", async (request) => {
  const query = z.object({ tenantId: z.string().optional() }).parse(request.query);
  return { automations: await engine.automations.list(query.tenantId) };
});
app.post("/v1/automations", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    name: z.string().min(1),
    description: z.string().optional(),
    sessionId: z.string(),
    prompt: z.string().min(1),
    trigger: automationTriggerSchema,
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().optional(),
    model: z.string().optional(),
  }).parse(request.body);
  let trigger: AutomationTrigger;
  if (body.trigger.kind === "manual") trigger = { kind: "manual" };
  else if (body.trigger.kind === "webhook") {
    trigger = {
      kind: "webhook",
      eventType: body.trigger.eventType,
      ...(body.trigger.secretEnvironmentVariable ? { secretEnvironmentVariable: body.trigger.secretEnvironmentVariable } : {}),
    };
  } else if (body.trigger.schedule.kind === "cron") {
    trigger = {
      kind: "schedule",
      schedule: {
        kind: "cron",
        expression: body.trigger.schedule.expression,
        ...(body.trigger.schedule.timezone ? { timezone: body.trigger.schedule.timezone } : {}),
      },
    };
  } else trigger = { kind: "schedule", schedule: body.trigger.schedule };
  return await reply.code(201).send(await engine.automations.create({
    tenantId: body.tenantId,
    name: body.name,
    ...(body.description ? { description: body.description } : {}),
    sessionId: body.sessionId,
    prompt: body.prompt,
    trigger,
    enabled: body.enabled,
    ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
    ...(body.model ? { model: body.model } : {}),
  }));
});
app.get("/v1/automations/:automationId", async (request) => {
  const { automationId } = z.object({ automationId: z.string() }).parse(request.params);
  return await engine.automations.get(automationId);
});
app.patch("/v1/automations/:automationId", async (request) => {
  const { automationId } = z.object({ automationId: z.string() }).parse(request.params);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
  return await engine.automations.setEnabled(automationId, enabled);
});
app.post("/v1/automations/:automationId/dispatch", async (request) => {
  const { automationId } = z.object({ automationId: z.string() }).parse(request.params);
  return await engine.automations.dispatch(automationId, "manual");
});
app.get("/v1/automations/:automationId/runs", async (request) => {
  const { automationId } = z.object({ automationId: z.string() }).parse(request.params);
  const { limit } = z.object({ limit: z.coerce.number().int().positive().max(1000).default(100) }).parse(request.query);
  return { runs: await engine.automations.listRuns(automationId, limit) };
});
app.post("/v1/automations/:automationId/webhook", async (request, reply) => {
  const { automationId } = z.object({ automationId: z.string() }).parse(request.params);
  const automation = await engine.automations.get(automationId);
  if (automation.trigger.kind !== "webhook") return await reply.code(409).send({ error: "not_webhook_automation" });
  const environmentVariable = automation.trigger.secretEnvironmentVariable;
  if (!environmentVariable || !process.env[environmentVariable]) return await reply.code(503).send({ error: "webhook_secret_not_configured" });
  if (request.headers["x-haf-automation-secret"] !== process.env[environmentVariable]) {
    return await reply.code(401).send({ error: "invalid_webhook_secret" });
  }
  return await engine.automations.dispatch(automationId, "webhook", request.body as JsonValue);
});

app.get("/v1/learning/refinement-reviews", async (request) => {
  const query = z.object({ tenantId: z.string().default("local"), sessionId: z.string().optional() }).parse(request.query);
  return { reviews: await engine.refinementPlanner.list(query.tenantId, query.sessionId) };
});
app.post("/v1/learning/refinements/plan", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    sessionId: z.string(),
    instructions: z.string().max(5000).optional(),
  }).parse(request.body);
  const session = await engine.session(body.sessionId);
  if (session.tenantId !== body.tenantId) return await reply.code(403).send({ error: "tenant_mismatch" });
  try {
    return await engine.refinementPlanner.plan(body.sessionId, "manual", body.instructions);
  } catch (error) {
    return await reply.code(422).send({
      error: "refinement_planner_rejected_output",
      message: error instanceof Error ? error.message.slice(0, 1000) : "Refinement planner failed.",
    });
  }
});

app.get("/v1/learning/refinements", async (request) => {
  const query = z.object({ tenantId: z.string().default("local"), sessionId: z.string().optional() }).parse(request.query);
  return { batches: await engine.refinements.list(query.tenantId, query.sessionId) };
});
app.post("/v1/learning/refinements", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    sessionId: z.string(),
    trigger: z.string().min(1).max(1000),
    rationale: z.string().min(1).max(5000),
    scope: z.enum(["session", "project", "user", "org"]).default("session"),
    evidenceEventIds: z.array(z.string()).max(200).default([]),
    edits: z.array(z.object({
      kind: z.enum(["memory", "skill", "prompt_addendum", "subagent_spec"]),
      title: z.string().min(1).max(300),
      content: z.string().min(1).max(100_000),
      expectedOutcome: z.string().min(1).max(5000),
      risk: z.enum(["low", "medium", "high"]).optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
    })).min(1).max(8),
  }).parse(request.body);
  return await reply.code(201).send(await engine.refinements.create({
    tenantId: body.tenantId,
    sessionId: body.sessionId,
    trigger: body.trigger,
    rationale: body.rationale,
    scope: body.scope,
    evidenceEventIds: body.evidenceEventIds,
    edits: body.edits.map((edit) => ({
      kind: edit.kind,
      title: edit.title,
      content: edit.content,
      expectedOutcome: edit.expectedOutcome,
      ...(edit.payload ? { payload: edit.payload as Record<string, JsonValue> } : {}),
      ...(edit.risk ? { risk: edit.risk } : {}),
    })),
    createdBy: "user",
  }));
});
app.post("/v1/learning/refinements/:refinementId/rollback", async (request) => {
  const { refinementId } = z.object({ refinementId: z.string() }).parse(request.params);
  return await engine.refinements.rollback(refinementId);
});

app.get("/v1/learning/candidates", async (request) => {
  const query = z.object({
    tenantId: z.string().default("local"),
    status: z.enum(["candidate", "scanned", "evaluated", "approved", "promoted", "rejected", "rolled_back"]).optional(),
  }).parse(request.query);
  return { candidates: await engine.learning.list(query.tenantId, query.status) };
});
app.post("/v1/learning/candidates", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"),
    sessionId: z.string(),
    kind: z.enum(["memory", "skill", "prompt_addendum", "subagent_spec"]),
    scope: z.enum(["session", "project", "user", "org"]).default("session"),
    title: z.string(),
    content: z.string(),
    payload: z.record(z.any()).optional(),
    evidenceEventIds: z.array(z.string()).default([]),
    expectedOutcome: z.string(),
    risk: z.enum(["low", "medium", "high"]).optional(),
  }).parse(request.body);
  return await reply.code(201).send(await engine.learning.propose({
    tenantId: body.tenantId,
    sessionId: body.sessionId,
    kind: body.kind,
    scope: body.scope,
    title: body.title,
    content: body.content,
    payload: (body.payload ?? {}) as Record<string, JsonValue>,
    evidenceEventIds: body.evidenceEventIds,
    expectedOutcome: body.expectedOutcome,
    ...(body.risk ? { risk: body.risk } : {}),
    createdBy: "user",
  }));
});
app.post("/v1/learning/candidates/:candidateId/evaluation", async (request) => {
  const { candidateId } = z.object({ candidateId: z.string() }).parse(request.params);
  const body = z.object({ passed: z.boolean(), checks: z.array(z.string()).default([]), summary: z.string() }).parse(request.body);
  return await engine.learning.recordEvaluation(candidateId, body);
});
app.post("/v1/learning/candidates/:candidateId/review", async (request) => {
  const { candidateId } = z.object({ candidateId: z.string() }).parse(request.params);
  const body = z.object({ decision: z.enum(["approve", "reject"]), reviewer: z.string().min(1), reason: z.string().optional() }).parse(request.body);
  return await engine.learning.review(candidateId, {
    decision: body.decision,
    reviewer: body.reviewer,
    ...(body.reason ? { reason: body.reason } : {}),
  });
});
app.post("/v1/learning/candidates/:candidateId/promote", async (request) => {
  const { candidateId } = z.object({ candidateId: z.string() }).parse(request.params);
  return await engine.learning.promote(candidateId);
});
app.post("/v1/learning/candidates/:candidateId/rollback", async (request) => {
  const { candidateId } = z.object({ candidateId: z.string() }).parse(request.params);
  return await engine.learning.rollback(candidateId);
});

app.get("/v1/learning/releases", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { releases: await engine.learningRollouts.list(tenantId) };
});
app.post("/v1/learning/releases", async (request, reply) => {
  const body = z.object({
    candidateId: z.string(), evalCommands: z.array(z.string()).min(1),
    canaryPercentage: z.number().min(1).max(100).optional(),
    minSamples: z.number().int().positive().optional(),
    requiredSuccessRate: z.number().min(0.5).max(1).optional(),
  }).parse(request.body);
  return await reply.code(201).send(await engine.learningRollouts.create({
    candidateId: body.candidateId,
    evalCommands: body.evalCommands,
    ...(body.canaryPercentage !== undefined ? { canaryPercentage: body.canaryPercentage } : {}),
    ...(body.minSamples !== undefined ? { minSamples: body.minSamples } : {}),
    ...(body.requiredSuccessRate !== undefined ? { requiredSuccessRate: body.requiredSuccessRate } : {}),
  }));
});
app.post("/v1/learning/releases/:releaseId/baseline", async (request) => {
  const { releaseId } = z.object({ releaseId: z.string() }).parse(request.params);
  return await engine.learningRollouts.runBaseline(releaseId);
});
app.post("/v1/learning/releases/:releaseId/evaluate", async (request) => {
  const { releaseId } = z.object({ releaseId: z.string() }).parse(request.params);
  return await engine.learningRollouts.runEvaluation(releaseId);
});
app.post("/v1/learning/releases/:releaseId/sign", async (request) => {
  const { releaseId } = z.object({ releaseId: z.string() }).parse(request.params);
  const body = z.object({ keyId: z.string(), signature: z.string() }).parse(request.body);
  return await engine.learningRollouts.submitSignature(releaseId, body);
});
app.post("/v1/learning/releases/:releaseId/outcomes", async (request) => {
  const { releaseId } = z.object({ releaseId: z.string() }).parse(request.params);
  const { success } = z.object({ success: z.boolean() }).parse(request.body);
  return await engine.learningRollouts.recordOutcome(releaseId, success);
});
app.post("/v1/learning/releases/:releaseId/rollback", async (request) => {
  const { releaseId } = z.object({ releaseId: z.string() }).parse(request.params);
  return await engine.learningRollouts.rollback(releaseId);
});

app.post("/v1/memories/:memoryId/promote", async (request) => {
  const { memoryId } = z.object({ memoryId: z.string() }).parse(request.params);
  return await engine.memory.promote(memoryId);
});

app.post("/v1/platforms/twilio/webhook", async (request, reply) => {
  if (!twilioSmsAdapter || !process.env.TWILIO_WEBHOOK_URL) return await reply.code(503).send({ error: "twilio_sms_webhook_not_configured" });
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) return await reply.code(400).send({ error: "twilio_sms_form_body_required" });
  try {
    await twilioSmsAdapter.acceptInbound(request.body as Record<string, unknown>, request.headers["x-twilio-signature"] as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return await reply.code(message.includes("signature") ? 401 : 403).send({ error: message.includes("signature") ? "invalid_twilio_signature" : "twilio_sms_not_allowed" });
  }
  return await reply.type("text/xml; charset=utf-8").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

app.post("/v1/platforms/github-app/webhook", async (request, reply) => {
  const raw = (request as any).rawBody as Buffer | undefined;
  if (!raw) return await reply.code(400).send({ error: "github_app_raw_body_missing" });
  try {
    return await engine.githubApps.ingestWebhook({
      rawBody: raw,
      signature: request.headers["x-hub-signature-256"] as string | undefined,
      deliveryId: request.headers["x-github-delivery"] as string | undefined,
      event: request.headers["x-github-event"] as string | undefined,
      payload: request.body,
    });
  } catch (error) {
    if (error instanceof GitHubAppWebhookVerificationError) return await reply.code(401).send({ error: "invalid_github_app_webhook_signature" });
    throw error;
  }
});

app.post("/v1/platforms/telegram/webhook", async (request, reply) => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret) return await reply.code(503).send({ error: "telegram_webhook_not_configured" });
  if (request.headers["x-telegram-bot-api-secret-token"] !== expectedSecret) {
    return await reply.code(401).send({ error: "invalid_telegram_webhook_secret" });
  }
  const update = request.body as any;
  const message = update?.message ?? update?.edited_message ?? update?.channel_post;
  if (!message?.chat?.id || !message?.from?.id || typeof message?.text !== "string") {
    return { ok: true, ignored: true };
  }
  const userId = String(message.from.id);
  const chatId = String(message.chat.id);
  const allowedUsers = new Set((process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  const allowedChats = new Set((process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  if (!allowedUsers.size && !allowedChats.size) return await reply.code(503).send({ error: "telegram_allowlist_not_configured" });
  const authorized = allowedUsers.has(userId) || allowedChats.has(chatId);
  if (!authorized) return await reply.code(403).send({ error: "telegram_sender_not_allowed" });
  const delivery = await engine.channels.ingest({
    tenantId: process.env.TELEGRAM_TENANT_ID ?? "local",
    platform: "telegram",
    chatId,
    chatType: message.chat.type === "private" ? "dm" : message.message_thread_id ? "thread" : "group",
    userId,
    text: message.text,
    messageId: String(message.message_id ?? update.update_id),
    authorized: true,
    ...(message.message_thread_id ? { threadId: String(message.message_thread_id) } : {}),
    metadata: { username: String(message.from.username ?? "") },
  });
  if (engine.outboundChannels.list().includes("telegram") && delivery.text) {
    await engine.outboundChannels.send("telegram", {
      destination: chatId,
      text: delivery.text,
      ...(message.message_thread_id ? { threadId: String(message.message_thread_id) } : {}),
    });
  }
  return { ok: true, sessionId: delivery.sessionId, status: delivery.status };
});

app.post("/v1/platforms/slack/webhook", async (request, reply) => {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const raw = (request as any).rawBody as Buffer | undefined;
  if (!signingSecret || !raw) return await reply.code(503).send({ error: "slack_webhook_not_configured" });
  if (!verifySlackSignature({
    rawBody: raw,
    timestamp: request.headers["x-slack-request-timestamp"] as string | undefined,
    signature: request.headers["x-slack-signature"] as string | undefined,
    signingSecret,
  })) return await reply.code(401).send({ error: "invalid_slack_signature" });
  const body = request.body as any;
  if (body?.type === "url_verification") return { challenge: body.challenge };
  const event = body?.event;
  if (!event || event.bot_id || event.subtype === "bot_message" || typeof event.text !== "string") return { ok: true, ignored: true };
  const userId = String(event.user ?? "");
  const channelId = String(event.channel ?? "");
  if (!allowlisted(userId, process.env.SLACK_ALLOWED_USER_IDS) && !allowlisted(channelId, process.env.SLACK_ALLOWED_CHANNEL_IDS)) {
    return await reply.code(403).send({ error: "slack_sender_not_allowed" });
  }
  const delivery = await engine.channels.ingest({
    tenantId: process.env.SLACK_TENANT_ID ?? "local",
    platform: "slack",
    chatId: channelId,
    chatType: event.thread_ts ? "thread" : "channel",
    userId,
    text: event.text,
    messageId: String(body.event_id ?? event.client_msg_id ?? event.ts),
    authorized: true,
    ...(event.thread_ts ? { threadId: String(event.thread_ts) } : {}),
  });
  if (engine.outboundChannels.list().includes("slack") && delivery.text) {
    await engine.outboundChannels.send("slack", { destination: channelId, text: delivery.text, ...(event.thread_ts ? { threadId: String(event.thread_ts) } : {}) });
  }
  return { ok: true, sessionId: delivery.sessionId };
});

app.post("/v1/platforms/discord/webhook", async (request, reply) => {
  const publicKey = process.env.DISCORD_APPLICATION_PUBLIC_KEY;
  const raw = (request as any).rawBody as Buffer | undefined;
  if (!publicKey || !raw) return await reply.code(503).send({ error: "discord_webhook_not_configured" });
  if (!verifyDiscordSignature({
    rawBody: raw,
    signature: request.headers["x-signature-ed25519"] as string | undefined,
    timestamp: request.headers["x-signature-timestamp"] as string | undefined,
    publicKeyHex: publicKey,
  })) return await reply.code(401).send({ error: "invalid_discord_signature" });
  const body = request.body as any;
  if (body?.type === 1) return { type: 1 };
  const userId = String(body?.member?.user?.id ?? body?.user?.id ?? "");
  const channelId = String(body?.channel_id ?? "");
  if (!allowlisted(userId, process.env.DISCORD_ALLOWED_USER_IDS) && !allowlisted(channelId, process.env.DISCORD_ALLOWED_CHANNEL_IDS)) {
    return await reply.code(403).send({ error: "discord_sender_not_allowed" });
  }
  const optionText = Array.isArray(body?.data?.options) ? body.data.options.map((option: any) => `${option.name}=${option.value}`).join(" ") : "";
  const text = String(body?.data?.name ? `/${body.data.name} ${optionText}` : body?.message?.content ?? body?.data?.custom_id ?? "").trim();
  if (!text) return { type: 4, data: { content: "No actionable text was supplied.", flags: 64 } };
  void engine.channels.ingest({
    tenantId: process.env.DISCORD_TENANT_ID ?? "local",
    platform: "discord",
    chatId: channelId,
    chatType: body?.guild_id ? "channel" : "dm",
    userId,
    text,
    messageId: String(body.id),
    authorized: true,
  }).then(async (delivery) => {
    if (engine.outboundChannels.list().includes("discord") && delivery.text) {
      await engine.outboundChannels.send("discord", { destination: channelId, text: delivery.text });
    }
  }).catch((error) => app.log.error({ errorClass: error instanceof Error ? error.name : "unknown" }, "discord background delivery failed"));
  return { type: 5 };
});

app.get("/v1/platforms/whatsapp/webhook", async (request, reply) => {
  const query = request.query as Record<string, string | undefined>;
  if (query["hub.mode"] === "subscribe" && verifySharedSecret(query["hub.verify_token"], process.env.WHATSAPP_VERIFY_TOKEN)) {
    return await reply.type("text/plain").send(query["hub.challenge"] ?? "");
  }
  return await reply.code(403).send({ error: "whatsapp_verification_failed" });
});
app.post("/v1/platforms/whatsapp/webhook", async (request, reply) => {
  const raw = (request as any).rawBody as Buffer | undefined;
  if (!raw || !process.env.WHATSAPP_APP_SECRET) return await reply.code(503).send({ error: "whatsapp_webhook_not_configured" });
  if (!verifyWhatsAppSignature(raw, request.headers["x-hub-signature-256"] as string | undefined, process.env.WHATSAPP_APP_SECRET)) {
    return await reply.code(401).send({ error: "invalid_whatsapp_signature" });
  }
  const body = request.body as any;
  const messages = (body?.entry ?? []).flatMap((entry: any) => (entry.changes ?? []).flatMap((change: any) => change?.value?.messages ?? []));
  for (const message of messages) {
    const userId = String(message.from ?? "");
    if (!allowlisted(userId, process.env.WHATSAPP_ALLOWED_PHONE_NUMBERS)) continue;
    const text = String(message?.text?.body ?? message?.button?.text ?? message?.interactive?.button_reply?.title ?? "");
    if (!text) continue;
    const delivery = await engine.channels.ingest({
      tenantId: process.env.WHATSAPP_TENANT_ID ?? "local", platform: "whatsapp", chatId: userId,
      chatType: "dm", userId, text, messageId: String(message.id), authorized: true,
    });
    if (engine.outboundChannels.list().includes("whatsapp") && delivery.text) {
      await engine.outboundChannels.send("whatsapp", { destination: userId, text: delivery.text });
    }
  }
  return { ok: true };
});

app.post("/v1/platforms/signal/webhook", async (request, reply) => {
  if (!verifySharedSecret(request.headers["x-haf-signal-secret"] as string | undefined, process.env.SIGNAL_WEBHOOK_SECRET)) {
    return await reply.code(401).send({ error: "invalid_signal_secret" });
  }
  const body = request.body as any;
  const envelope = body?.envelope ?? body;
  const userId = String(envelope?.sourceNumber ?? envelope?.source ?? "");
  if (!allowlisted(userId, process.env.SIGNAL_ALLOWED_NUMBERS)) return await reply.code(403).send({ error: "signal_sender_not_allowed" });
  const text = String(envelope?.dataMessage?.message ?? envelope?.message ?? "");
  if (!text) return { ok: true, ignored: true };
  const delivery = await engine.channels.ingest({
    tenantId: process.env.SIGNAL_TENANT_ID ?? "local", platform: "signal", chatId: userId,
    chatType: "dm", userId, text, messageId: String(envelope?.timestamp ?? randomUUID()), authorized: true,
  });
  if (engine.outboundChannels.list().includes("signal") && delivery.text) await engine.outboundChannels.send("signal", { destination: userId, text: delivery.text });
  return { ok: true, sessionId: delivery.sessionId };
});

app.post("/v1/platforms/matrix/webhook", async (request, reply) => {
  if (!verifySharedSecret(request.headers["x-haf-matrix-secret"] as string | undefined, process.env.MATRIX_WEBHOOK_SECRET)) {
    return await reply.code(401).send({ error: "invalid_matrix_secret" });
  }
  const event = request.body as any;
  const userId = String(event?.sender ?? "");
  const roomId = String(event?.room_id ?? "");
  if (!allowlisted(userId, process.env.MATRIX_ALLOWED_USER_IDS) && !allowlisted(roomId, process.env.MATRIX_ALLOWED_ROOM_IDS)) {
    return await reply.code(403).send({ error: "matrix_sender_not_allowed" });
  }
  const text = String(event?.content?.body ?? "");
  if (!text || event?.content?.msgtype !== "m.text") return { ok: true, ignored: true };
  const delivery = await engine.channels.ingest({
    tenantId: process.env.MATRIX_TENANT_ID ?? "local", platform: "matrix", chatId: roomId,
    chatType: "channel", userId, text, messageId: String(event?.event_id ?? randomUUID()), authorized: true,
  });
  if (engine.outboundChannels.list().includes("matrix") && delivery.text) await engine.outboundChannels.send("matrix", { destination: roomId, text: delivery.text });
  return { ok: true, sessionId: delivery.sessionId };
});

app.post("/v1/platforms/mattermost/webhook", async (request, reply) => {
  const expected = process.env.MATTERMOST_WEBHOOK_TOKEN;
  if (!expected) return await reply.code(503).send({ error: "mattermost_webhook_not_configured" });
  const body = request.body as any;
  const provided = (request.headers["x-mattermost-token"] as string | undefined) ?? (typeof body?.token === "string" ? body.token : undefined);
  if (!verifySharedSecret(provided, expected)) return await reply.code(401).send({ error: "invalid_mattermost_token" });
  const userId = String(body?.user_id ?? ""), channelId = String(body?.channel_id ?? ""), text = String(body?.text ?? "").trim();
  if (!allowlisted(userId, process.env.MATTERMOST_ALLOWED_USER_IDS) && !allowlisted(channelId, process.env.MATTERMOST_ALLOWED_CHANNEL_IDS)) return await reply.code(403).send({ error: "mattermost_sender_not_allowed" });
  if (!text) return { ok: true, ignored: true };
  void engine.channels.ingest({
    tenantId: process.env.MATTERMOST_TENANT_ID ?? "local", platform: "mattermost", chatId: channelId,
    chatType: body?.root_id ? "thread" : "channel", userId, text,
    messageId: String(body?.post_id ?? randomUUID()), authorized: true,
    ...(body?.root_id ? { threadId: String(body.root_id) } : {}),
  }).then(async (delivery) => {
    if (engine.outboundChannels.list().includes("mattermost") && delivery.text) await engine.outboundChannels.send("mattermost", { destination: channelId, text: delivery.text, ...(body?.root_id ? { threadId: String(body.root_id) } : {}) });
  }).catch((error) => app.log.error({ errorClass: error instanceof Error ? error.name : "unknown" }, "mattermost background delivery failed"));
  return { ok: true };
});

app.post("/v1/platforms/line/webhook", async (request, reply) => {
  const raw = (request as any).rawBody as Buffer | undefined;
  if (!raw || !process.env.LINE_CHANNEL_SECRET) return await reply.code(503).send({ error: "line_webhook_not_configured" });
  if (!verifyLineSignature(raw, request.headers["x-line-signature"] as string | undefined, process.env.LINE_CHANNEL_SECRET)) return await reply.code(401).send({ error: "invalid_line_signature" });
  const events = Array.isArray((request.body as any)?.events) ? (request.body as any).events.slice(0, 100) : [];
  for (const event of events) {
    if (event?.type !== "message" || event?.message?.type !== "text") continue;
    const userId = String(event?.source?.userId ?? "");
    const chatId = String(event?.source?.groupId ?? event?.source?.roomId ?? userId);
    if (!allowlisted(userId, process.env.LINE_ALLOWED_USER_IDS) && !allowlisted(chatId, process.env.LINE_ALLOWED_CHAT_IDS)) continue;
    void engine.channels.ingest({
      tenantId: process.env.LINE_TENANT_ID ?? "local", platform: "line", chatId,
      chatType: event?.source?.type === "user" ? "dm" : "group", userId,
      text: String(event.message.text), messageId: String(event?.webhookEventId ?? event?.message?.id ?? randomUUID()), authorized: true,
    }).then(async (delivery) => {
      if (engine.outboundChannels.list().includes("line") && delivery.text) await engine.outboundChannels.send("line", { destination: chatId, text: delivery.text });
    }).catch((error) => app.log.error({ errorClass: error instanceof Error ? error.name : "unknown" }, "line background delivery failed"));
  }
  return { ok: true };
});

app.post("/v1/platforms/google-chat/webhook", async (request, reply) => {
  if (!googleChatJwtVerifier) return await reply.code(503).send({ error: "google_chat_webhook_not_configured" });
  try { await googleChatJwtVerifier.verify(request.headers.authorization); }
  catch { return await reply.code(401).send({ error: "invalid_google_chat_token" }); }
  const body = request.body as any;
  if (String(body?.type ?? "").toUpperCase() !== "MESSAGE") return { ok: true, ignored: true };
  const userId = String(body?.user?.name ?? body?.message?.sender?.name ?? "");
  const spaceId = String(body?.space?.name ?? body?.message?.space?.name ?? "");
  if (!allowlisted(userId, process.env.GOOGLE_CHAT_ALLOWED_USER_IDS) && !allowlisted(spaceId, process.env.GOOGLE_CHAT_ALLOWED_SPACE_IDS)) return await reply.code(403).send({ error: "google_chat_sender_not_allowed" });
  const text = String(body?.message?.argumentText ?? body?.message?.text ?? "").trim();
  if (!text) return { ok: true, ignored: true };
  const threadId = body?.message?.thread?.name ? String(body.message.thread.name) : undefined;
  void engine.channels.ingest({
    tenantId: process.env.GOOGLE_CHAT_TENANT_ID ?? "local", platform: "google-chat", chatId: spaceId,
    chatType: threadId ? "thread" : "channel", userId, text,
    messageId: String(body?.message?.name ?? randomUUID()), authorized: true, ...(threadId ? { threadId } : {}),
  }).then(async (delivery) => {
    if (engine.outboundChannels.list().includes("google-chat") && delivery.text) await engine.outboundChannels.send("google-chat", { destination: spaceId, text: delivery.text, ...(threadId ? { threadId } : {}) });
  }).catch((error) => app.log.error({ errorClass: error instanceof Error ? error.name : "unknown" }, "google chat background delivery failed"));
  return { ok: true };
});

app.post("/v1/platforms/teams/webhook", async (request, reply) => {
  if (!teamsJwtVerifier) return await reply.code(503).send({ error: "teams_webhook_not_configured" });
  try { await teamsJwtVerifier.verify(request.headers.authorization); }
  catch { return await reply.code(401).send({ error: "invalid_teams_token" }); }
  const activity = request.body as any;
  if (activity?.type !== "message") return { ok: true, ignored: true };
  const userId = String(activity?.from?.id ?? ""), conversationId = String(activity?.conversation?.id ?? "");
  if (!allowlisted(userId, process.env.TEAMS_ALLOWED_USER_IDS) && !allowlisted(conversationId, process.env.TEAMS_ALLOWED_CONVERSATION_IDS)) return await reply.code(403).send({ error: "teams_sender_not_allowed" });
  const text = String(activity?.text ?? "").replace(/<at>[^<]*<\/at>/gi, "").trim();
  if (!text) return { ok: true, ignored: true };
  const threadId = activity?.replyToId ? String(activity.replyToId) : undefined;
  void engine.channels.ingest({
    tenantId: process.env.TEAMS_TENANT_ID ?? "local", platform: "teams", chatId: conversationId,
    chatType: threadId ? "thread" : "channel", userId, text, messageId: String(activity?.id ?? randomUUID()),
    authorized: true, ...(threadId ? { threadId } : {}), metadata: { channelId: String(activity?.channelId ?? "") },
  }).then(async (delivery) => {
    if (engine.outboundChannels.list().includes("teams") && delivery.text) await engine.outboundChannels.send("teams", { destination: `chat:${conversationId}`, text: delivery.text });
  }).catch((error) => app.log.error({ errorClass: error instanceof Error ? error.name : "unknown" }, "teams background delivery failed"));
  return { ok: true };
});

app.post("/v1/platforms/feishu/webhook", async (request, reply) => {
  const raw = (request as any).rawBody as Buffer | undefined;
  const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;
  if (!raw || !verificationToken) return await reply.code(503).send({ error: "feishu_webhook_not_configured" });
  if (process.env.FEISHU_ENCRYPT_KEY && !verifyFeishuSignature({
    rawBody: raw,
    timestamp: request.headers["x-lark-request-timestamp"] as string | undefined,
    nonce: request.headers["x-lark-request-nonce"] as string | undefined,
    signature: request.headers["x-lark-signature"] as string | undefined,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY,
  })) return await reply.code(401).send({ error: "invalid_feishu_signature" });
  const body = request.body as any;
  const suppliedToken = String(body?.header?.token ?? body?.token ?? "");
  if (!verifySharedSecret(suppliedToken, verificationToken)) return await reply.code(401).send({ error: "invalid_feishu_token" });
  if (body?.type === "url_verification") return { challenge: body.challenge };
  if (body?.header?.event_type !== "im.message.receive_v1") return { ok: true, ignored: true };
  const event = body?.event;
  const userId = String(event?.sender?.sender_id?.open_id ?? event?.sender?.sender_id?.user_id ?? "");
  const chatId = String(event?.message?.chat_id ?? "");
  if (!allowlisted(userId, process.env.FEISHU_ALLOWED_USER_IDS) && !allowlisted(chatId, process.env.FEISHU_ALLOWED_CHAT_IDS)) return await reply.code(403).send({ error: "feishu_sender_not_allowed" });
  let content: any = {};
  try { content = JSON.parse(String(event?.message?.content ?? "{}")); } catch {}
  const text = String(content?.text ?? "").trim();
  if (!text) return { ok: true, ignored: true };
  const threadId = event?.message?.root_id ? String(event.message.root_id) : undefined;
  void engine.channels.ingest({
    tenantId: process.env.FEISHU_TENANT_ID ?? "local", platform: "feishu", chatId,
    chatType: threadId ? "thread" : event?.message?.chat_type === "p2p" ? "dm" : "group",
    userId, text, messageId: String(body?.header?.event_id ?? event?.message?.message_id ?? randomUUID()), authorized: true,
    ...(threadId ? { threadId } : {}),
  }).then(async (delivery) => {
    if (engine.outboundChannels.list().includes("feishu") && delivery.text) await engine.outboundChannels.send("feishu", { destination: chatId, text: delivery.text, ...(event?.message?.message_id ? { threadId: String(event.message.message_id) } : {}) });
  }).catch((error) => app.log.error({ errorClass: error instanceof Error ? error.name : "unknown" }, "feishu background delivery failed"));
  return { ok: true };
});

app.get("/v1/channel-routing-rules", async (request) => {
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return { rules: await engine.channels.listRoutingRules(tenantId) };
});
app.post("/v1/channel-routing-rules", async (request, reply) => {
  const body = z.object({
    tenantId: z.string().default("local"), name: z.string().min(1).max(200),
    priority: z.number().int().min(-10000).max(10000).optional(),
    platforms: z.array(z.string()).max(50).optional(),
    chatTypes: z.array(z.enum(["dm", "group", "channel", "thread"])).max(4).optional(),
    chatIds: z.array(z.string()).max(500).optional(), userIds: z.array(z.string()).max(500).optional(),
    metadataEquals: z.record(z.string(), z.string()).optional(),
    sessionScope: z.enum(["chat", "user", "thread"]).default("chat"),
    agentProfileId: z.string().optional(),
  }).parse(request.body);
  return await reply.code(201).send(await engine.channels.addRoutingRule({
    tenantId: body.tenantId,
    name: body.name,
    sessionScope: body.sessionScope,
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
    ...(body.platforms ? { platforms: body.platforms } : {}),
    ...(body.chatTypes ? { chatTypes: body.chatTypes } : {}),
    ...(body.chatIds ? { chatIds: body.chatIds } : {}),
    ...(body.userIds ? { userIds: body.userIds } : {}),
    ...(body.metadataEquals ? { metadataEquals: body.metadataEquals } : {}),
    ...(body.agentProfileId ? { agentProfileId: body.agentProfileId } : {}),
  }));
});
app.patch("/v1/channel-routing-rules/:ruleId", async (request) => {
  const { ruleId } = z.object({ ruleId: z.string() }).parse(request.params);
  const body = z.object({ tenantId: z.string().default("local"), enabled: z.boolean() }).parse(request.body);
  return await engine.channels.setRoutingRuleEnabled(ruleId, body.tenantId, body.enabled);
});
app.delete("/v1/channel-routing-rules/:ruleId", async (request, reply) => {
  const { ruleId } = z.object({ ruleId: z.string() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  return await engine.channels.removeRoutingRule(ruleId, tenantId) ? await reply.code(204).send() : await reply.code(404).send({ error: "routing_rule_not_found" });
});

app.get("/v1/channels/adapters", async () => ({ adapters: engine.outboundChannels.list(), statuses: engine.outboundChannels.statuses() }));
app.get("/v1/channels/routes", async (request) => {
  const query = z.object({ tenantId: z.string().optional() }).parse(request.query);
  return { routes: await engine.channels.listRoutes(query.tenantId) };
});
app.post("/v1/channels/webhook/:platform", async (request, reply) => {
  const expected = process.env.HAF_WEBHOOK_TOKEN;
  if (!expected) return await reply.code(503).send({ error: "webhook_not_configured" });
  if (request.headers["x-haf-webhook-token"] !== expected) return await reply.code(401).send({ error: "unauthorized_webhook" });
  const { platform } = z.object({ platform: z.string().min(1) }).parse(request.params);
  const body = z.object({
    tenantId: z.string().default("local"),
    chatId: z.string().min(1),
    chatType: z.enum(["dm", "group", "channel", "thread"]).default("dm"),
    userId: z.string().min(1),
    text: z.string().min(1),
    threadId: z.string().optional(),
    messageId: z.string().optional(),
    metadata: z.record(z.string()).optional(),
  }).parse(request.body);
  return await engine.channels.ingest({
    tenantId: body.tenantId,
    platform,
    chatId: body.chatId,
    chatType: body.chatType,
    userId: body.userId,
    text: body.text,
    authorized: true,
    ...(body.threadId ? { threadId: body.threadId } : {}),
    ...(body.messageId ? { messageId: body.messageId } : {}),
    ...(body.metadata ? { metadata: body.metadata } : {}),
  });
});

app.get("/v1/plugins/wasi", async () => ({ configured: Boolean(engine.wasiPlugins), plugins: engine.wasiPlugins?.list() ?? [] }));
app.post("/v1/plugins/wasi", async (request, reply) => {
  if (!engine.wasiPlugins) return await reply.code(409).send({ error: "wasi_plugins_not_configured" });
  const { sourceDirectory } = z.object({ sourceDirectory: z.string().min(1) }).parse(request.body);
  return await reply.code(201).send(await engine.wasiPlugins.install(sourceDirectory));
});
app.delete("/v1/plugins/wasi/:pluginId", async (request, reply) => {
  if (!engine.wasiPlugins) return await reply.code(409).send({ error: "wasi_plugins_not_configured" });
  const { pluginId } = z.object({ pluginId: z.string() }).parse(request.params);
  await engine.wasiPlugins.uninstall(pluginId);
  return await reply.code(204).send();
});

app.get("/v1/mcp/elicitations", async (request) => {
  const query = z.object({
    tenantId: z.string().default("local"),
    status: z.enum(["pending", "accepted", "declined", "cancelled", "expired"]).default("pending"),
  }).parse(request.query);
  return { elicitations: await engine.mcpElicitations.list(query.tenantId, query.status) };
});
app.post("/v1/mcp/elicitations/:elicitationId/resolve", async (request, reply) => {
  const { elicitationId } = z.object({ elicitationId: z.string() }).parse(request.params);
  const body = z.object({
    tenantId: z.string().default("local"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.unknown()).optional(),
  }).parse(request.body);
  try {
    return await engine.mcpElicitations.resolve(body.tenantId, elicitationId, {
      action: body.action,
      ...(body.content ? { content: body.content as Record<string, JsonValue> } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = message.includes("missing, expired") || message.includes("no live transport");
    return await reply.code(missing ? 409 : 400).send({ error: "mcp_elicitation_resolution_failed", message });
  }
});

app.get("/v1/mcp/servers", async () => ({ servers: engine.mcp.list() }));
app.get("/v1/mcp/schema-cache", async () => ({ schemas: await engine.mcp.listCachedSchemas() }));
app.post("/v1/mcp/servers/stdio", async (request, reply) => {
  const body = z.object({
    name: z.string().min(1),
    tenantId: z.string().default("local"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    defaultRisk: z.enum(["pure", "workspace_read", "workspace_write", "process", "network", "external_side_effect", "privileged"]).optional(),
  }).parse(request.body);
  return await reply.code(201).send(await engine.mcp.connectStdio({
    name: body.name,
    tenantId: body.tenantId,
    command: body.command,
    ...(body.args ? { args: body.args } : {}),
    ...(body.cwd ? { cwd: body.cwd } : {}),
    ...(body.env ? { env: body.env } : {}),
    ...(body.defaultRisk ? { defaultRisk: body.defaultRisk } : {}),
  }));
});
app.post("/v1/mcp/servers/http", async (request, reply) => {
  const body = z.object({
    name: z.string().min(1),
    tenantId: z.string().default("local"),
    url: z.string().url(),
    defaultRisk: z.enum(["pure", "workspace_read", "workspace_write", "process", "network", "external_side_effect", "privileged"]).optional(),
    bearerTokenEnvironmentVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    headerEnvironmentVariables: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
    tlsCertificatePathEnvironmentVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    tlsPrivateKeyPathEnvironmentVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    tlsCaPathEnvironmentVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    tlsServerName: z.string().max(253).optional(),
    oauth: z.object({
      clientIdEnvironmentVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
      clientSecretEnvironmentVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
      scopes: z.array(z.string().min(1).max(200)).max(50).optional(),
      authorizationServerOrigins: z.array(z.string().url().max(8192)).max(20).optional(),
    }).optional(),
    allowPlainHttp: z.boolean().default(false),
    toolTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
  }).parse(request.body);
  const headers: Record<string, string> = {};
  if (body.bearerTokenEnvironmentVariable) {
    const token = process.env[body.bearerTokenEnvironmentVariable];
    if (!token) throw new Error(`MCP bearer token environment variable ${body.bearerTokenEnvironmentVariable} is not set.`);
    headers.authorization = `Bearer ${token}`;
  }
  for (const [header, environmentVariable] of Object.entries(body.headerEnvironmentVariables ?? {})) {
    const value = process.env[environmentVariable];
    if (!value) throw new Error(`MCP header environment variable ${environmentVariable} is not set.`);
    headers[header] = value;
  }
  const hasAnyTls = Boolean(body.tlsCertificatePathEnvironmentVariable || body.tlsPrivateKeyPathEnvironmentVariable || body.tlsCaPathEnvironmentVariable);
  if (hasAnyTls && (!body.tlsCertificatePathEnvironmentVariable || !body.tlsPrivateKeyPathEnvironmentVariable)) {
    throw new Error("MCP mTLS requires both certificate and private-key path environment variables.");
  }
  const readTlsFile = async (environmentVariable: string): Promise<Buffer> => {
    const path = process.env[environmentVariable];
    if (!path) throw new Error(`MCP TLS path environment variable ${environmentVariable} is not set.`);
    const data = await readFile(path);
    if (data.length > 1024 * 1024) throw new Error(`MCP TLS file referenced by ${environmentVariable} exceeds 1 MiB.`);
    return data;
  };
  const tls = hasAnyTls ? {
    certificate: await readTlsFile(body.tlsCertificatePathEnvironmentVariable!),
    privateKey: await readTlsFile(body.tlsPrivateKeyPathEnvironmentVariable!),
    ...(body.tlsCaPathEnvironmentVariable ? { certificateAuthority: await readTlsFile(body.tlsCaPathEnvironmentVariable) } : {}),
    ...(body.tlsServerName ? { serverName: body.tlsServerName } : {}),
  } : undefined;
  if (body.oauth && body.bearerTokenEnvironmentVariable) throw new Error("MCP OAuth cannot be combined with a static bearer token.");
  let oauthProvider: BrokerBackedMcpOAuthProvider | undefined;
  if (body.oauth) {
    const redirectUrl = process.env.HAF_MCP_OAUTH_REDIRECT_URI;
    if (!redirectUrl) throw new Error("HAF_MCP_OAUTH_REDIRECT_URI is required for MCP OAuth.");
    const clientId = body.oauth.clientIdEnvironmentVariable ? process.env[body.oauth.clientIdEnvironmentVariable] : undefined;
    const clientSecret = body.oauth.clientSecretEnvironmentVariable ? process.env[body.oauth.clientSecretEnvironmentVariable] : undefined;
    if (body.oauth.clientIdEnvironmentVariable && !clientId) throw new Error(`MCP OAuth client ID environment variable ${body.oauth.clientIdEnvironmentVariable} is not set.`);
    if (body.oauth.clientSecretEnvironmentVariable && !clientSecret) throw new Error(`MCP OAuth client secret environment variable ${body.oauth.clientSecretEnvironmentVariable} is not set.`);
    if (clientSecret && !clientId) throw new Error("MCP OAuth client secret requires a client ID.");
    oauthProvider = new BrokerBackedMcpOAuthProvider({
      tenantId: body.tenantId,
      serverUrl: body.url,
      redirectUrl,
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(body.oauth.scopes ? { scopes: body.oauth.scopes } : {}),
      ...(body.oauth.authorizationServerOrigins ? { authorizationServerOrigins: body.oauth.authorizationServerOrigins } : {}),
      broker: engine.credentials,
    });
  }
  const connection = await engine.mcp.connectHttp({
    name: body.name,
    tenantId: body.tenantId,
    url: body.url,
    ...(body.defaultRisk ? { defaultRisk: body.defaultRisk } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(tls ? { tls } : {}),
    ...(oauthProvider ? { oauthProvider } : {}),
    allowPlainHttp: body.allowPlainHttp,
    ...(body.toolTimeoutMs ? { toolTimeoutMs: body.toolTimeoutMs } : {}),
  });
  if (connection.authorizationRequired && connection.oauthConnectionId && connection.authorizationUrl && oauthProvider) {
    return await reply.code(202).send(connection);
  }
  return await reply.code(201).send(connection);
});

app.delete("/v1/mcp/servers/:name", async (request, reply) => {
  const { name } = z.object({ name: z.string() }).parse(request.params);
  await engine.mcp.disconnect(name);
  return await reply.code(204).send();
});

app.get("/v1/skills/hub/sources", async () => ({ sources: await engine.skillsHub.listSources() }));
app.post("/v1/skills/hub/sources", async (request, reply) => {
  const body = z.object({ id: z.string(), indexUrl: z.string().url(), trust: z.enum(["trusted", "community"]).default("community") }).parse(request.body);
  return await reply.code(201).send(await engine.skillsHub.addSource(body));
});
app.post("/v1/skills/hub/refresh", async (request) => {
  const body = z.object({ sourceId: z.string().optional() }).parse(request.body ?? {});
  return await engine.skillsHub.refresh(body.sourceId);
});
app.get("/v1/skills/hub/search", async (request) => {
  const query = z.object({ q: z.string().default(""), sourceId: z.string().optional(), limit: z.coerce.number().int().positive().max(100).default(50) }).parse(request.query);
  return { entries: await engine.skillsHub.search(query.q, { ...(query.sourceId ? { sourceId: query.sourceId } : {}), limit: query.limit }) };
});
app.post("/v1/skills/hub/install", async (request, reply) => {
  const body = z.object({ sourceId: z.string(), name: z.string(), version: z.string().optional() }).parse(request.body);
  return await reply.code(201).send(await engine.skillsHub.install({
    sourceId: body.sourceId,
    name: body.name,
    ...(body.version ? { version: body.version } : {}),
  }));
});

app.get("/v1/skills", async () => ({ skills: await engine.skills.list() }));
app.post("/v1/skills/candidates", async (request, reply) => {
  const body = z.object({ name: z.string(), description: z.string(), content: z.string(), source: z.string().default("control-api") }).parse(request.body);
  return await reply.code(201).send(await engine.skills.createCandidate({ ...body, createdBy: "user" }));
});
app.post("/v1/skills/candidates/:directory/promote", async (request) => {
  const { directory } = z.object({ directory: z.string() }).parse(request.params);
  const { tenantId } = z.object({ tenantId: z.string().default("local") }).parse(request.query);
  const manifest = await engine.skills.promote(directory);
  const skill = await engine.skills.get(manifest.name);
  await engine.knowledgeIndex.upsert({
    id: `skill:${manifest.name}`,
    tenantId,
    kind: "skill",
    text: `${manifest.name}\n${manifest.description}\n${skill.content}`,
    metadata: { skillName: manifest.name, version: manifest.version },
  });
  return manifest;
});

// ═══ Phase1-5: Cognitive Architecture API Endpoints ═══

// Self-Model
app.get("/v1/self-model", async (request) => { const q = auroraTenant.parse(request.query); return await engine.selfModel.getFullState(q.tenantId); });
app.post("/v1/self-model/goals", async (request) => { const b = z.object({ tenantId: z.string().default("local"), title: z.string(), description: z.string(), priority: z.number().optional(), parentId: z.string().optional() }).parse(request.body); return await engine.selfModel.addGoal(b.tenantId, b.title, b.description, b.priority, b.parentId); });
app.post("/v1/self-model/beliefs", async (request) => { const b = z.object({ tenantId: z.string().default("local"), claim: z.string(), confidence: z.number(), source: z.string(), tags: z.array(z.string()).optional() }).parse(request.body); return await engine.selfModel.addBelief(b.tenantId, b.claim, b.confidence, b.source as any, b.tags); });
app.post("/v1/self-model/capabilities", async (request) => { const b = z.object({ tenantId: z.string().default("local"), domain: z.string(), level: z.string(), notes: z.string().optional() }).parse(request.body); return await engine.selfModel.assessCapability(b.tenantId, b.domain, b.level as any, b.notes); });
app.post("/v1/self-model/hypotheses", async (request) => { const b = z.object({ tenantId: z.string().default("local"), statement: z.string(), confidence: z.number() }).parse(request.body); return await engine.selfModel.proposeHypothesis(b.tenantId, b.statement, b.confidence); });
app.post("/v1/self-model/reflect", async (request) => { const b = z.object({ tenantId: z.string().default("local"), trigger: z.enum(["task", "failure", "milestone", "periodic"]).default("periodic") }).parse(request.body ?? {}); return await engine.selfModel.reflect(b.tenantId, b.trigger); });
app.get("/v1/self-model/decision-inputs", async (request) => { const q = auroraTenant.parse(request.query); return await engine.selfModel.decisionInputs(q.tenantId, { availableCapabilities: () => engine.capabilities.list().map((item) => item.id), availableModels: () => engine.models.list() }); });
app.get("/v1/self-model/limitations", async (request) => { const q = auroraTenant.parse(request.query); return { limitations: await engine.selfModel.knownLimitations(q.tenantId) }; });
app.post("/v1/self-model/advise", async (request) => { const b = z.object({ tenantId: z.string().default("local"), task: z.string().min(1) }).parse(request.body); return await engine.selfModel.advise(b.tenantId, b.task); });
app.get("/v1/self-model/strategy-advice", async (request) => { const q = auroraTenant.parse(request.query); return await engine.selfModel.strategyAdvice(q.tenantId); });
app.post("/v1/self-model/strategy-outcomes", async (request) => { const b = z.object({ tenantId: z.string().default("local"), strategy: z.enum(["direct", "exploratory", "decompose", "delegate", "simulate", "fallback"]), success: z.boolean(), context: z.string().max(200).optional() }).parse(request.body); return await engine.selfModel.recordStrategyOutcome(b.tenantId, b.strategy, b.success, ...(b.context ? [b.context] : [])); });
app.post("/v1/self-model/strategy", async (request) => { const b = z.object({ type: z.string(), description: z.string(), confidence: z.number() }).parse(request.body); await engine.selfModel.switchStrategy(b.type as any, b.description, b.confidence); return { ok: true }; });

// Uncertainty Engine
app.get("/v1/uncertainty/claims", async (request) => { const q = z.object({ tenantId: z.string().default("local"), domain: z.string().optional(), status: z.string().optional() }).parse(request.query); return { claims: await engine.uncertaintyEngine.getClaims(q.tenantId, q.domain, q.status) }; });
app.post("/v1/uncertainty/assert", async (request) => { const b = z.object({ tenantId: z.string().default("local"), claim: z.string(), domain: z.string(), confidence: z.number(), evidence: z.array(z.any()).optional(), assumptions: z.array(z.string()).optional(), uncertaintySources: z.array(z.string()).optional(), requiredVerification: z.array(z.string()).optional() }).parse(request.body); const opts: { evidence?: any[]; assumptions?: string[]; uncertaintySources?: any[]; requiredVerification?: string[] } = {}; if (b.evidence) opts.evidence = b.evidence; if (b.assumptions) opts.assumptions = b.assumptions; if (b.uncertaintySources) opts.uncertaintySources = b.uncertaintySources; if (b.requiredVerification) opts.requiredVerification = b.requiredVerification; return await engine.uncertaintyEngine.assert(b.tenantId, b.claim, b.domain, b.confidence, opts); });
app.get("/v1/uncertainty/confident", async (request) => { const q = z.object({ tenantId: z.string().default("local"), threshold: z.coerce.number().default(0.7) }).parse(request.query); return { claims: await engine.uncertaintyEngine.getConfident(q.tenantId, q.threshold) }; });
app.get("/v1/uncertainty/uncertain", async (request) => { const q = z.object({ tenantId: z.string().default("local"), threshold: z.coerce.number().default(0.4) }).parse(request.query); return { claims: await engine.uncertaintyEngine.getUncertain(q.tenantId, q.threshold) }; });
app.get("/v1/uncertainty/calibration", async () => { return await engine.uncertaintyEngine.getCalibrationStats(); });

// Failure Taxonomy
app.get("/v1/failures", async (request) => { const q = z.object({ tenantId: z.string().default("local"), category: z.string().optional(), unresolvedOnly: z.coerce.boolean().optional() }).parse(request.query); return { failures: await engine.failureTaxonomy.getFailures(q.tenantId, q.category as any, q.unresolvedOnly) }; });
app.post("/v1/failures/classify", async (request) => { const b = z.object({ tenantId: z.string().default("local"), description: z.string(), category: z.string(), severity: z.string(), rootCause: z.string(), sessionId: z.string().optional(), taskId: z.string().optional(), contributingFactors: z.array(z.string()).optional(), capabilityGap: z.string().optional(), suggestedFix: z.string().optional() }).parse(request.body); const opts: { sessionId?: string; taskId?: string; contributingFactors?: string[]; capabilityGap?: string; suggestedFix?: string } = {}; if (b.sessionId) opts.sessionId = b.sessionId; if (b.taskId) opts.taskId = b.taskId; if (b.contributingFactors) opts.contributingFactors = b.contributingFactors; if (b.capabilityGap) opts.capabilityGap = b.capabilityGap; if (b.suggestedFix) opts.suggestedFix = b.suggestedFix; return await engine.failureTaxonomy.classify(b.tenantId, b.description, b.category as any, b.severity as any, b.rootCause, opts); });
app.get("/v1/failures/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.failureTaxonomy.getStats(q.tenantId); });
app.get("/v1/failures/patterns", async (request) => { const q = auroraTenant.parse(request.query); return { patterns: await engine.failureTaxonomy.getPatterns(q.tenantId) }; });
app.get("/v1/failures/recommendations", async (request) => { const q = auroraTenant.parse(request.query); return { recommendations: await engine.failureTaxonomy.getRecommendations(q.tenantId) }; });

// Cognitive Telemetry
app.get("/v1/telemetry/traces", async (request) => { const q = z.object({ tenantId: z.string().default("local"), sessionId: z.string().optional(), outcome: z.string().optional(), limit: z.coerce.number().default(50) }).parse(request.query); return { traces: await engine.cognitiveTelemetry.getTraces(q.tenantId, q.sessionId, q.outcome, q.limit) }; });
app.get("/v1/telemetry/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.cognitiveTelemetry.getStats(q.tenantId); });
app.get("/v1/telemetry/insights", async (request) => { const q = auroraTenant.parse(request.query); return { traces: await engine.cognitiveTelemetry.getInsightfulTraces(q.tenantId) }; });

// Neural Memory Fusion
app.get("/v1/neural-fusion/stats", async (request) => { const q = auroraTenant.parse(request.query); return await engine.neuralMemoryFusion.getStats(q.tenantId); });
app.get("/v1/neural-fusion/patterns", async (request) => { const q = auroraTenant.parse(request.query); return { patterns: await engine.neuralMemoryFusion.getPatterns(q.tenantId) }; });
app.post("/v1/neural-fusion/similar", async (request) => { const b = z.object({ tenantId: z.string().default("local"), query: z.string(), limit: z.number().optional(), layer: z.string().optional() }).parse(request.body); return { results: await engine.neuralMemoryFusion.findSimilar(b.tenantId, b.query, b.limit, b.layer) }; });
app.post("/v1/neural-fusion/consolidate", async (request) => { const b = auroraTenant.parse(request.body ?? {}); return await engine.neuralMemoryFusion.consolidate(b.tenantId); });

// Experience Compiler
app.get("/v1/experience-compiler/skills", async (request) => { const q = auroraTenant.parse(request.query); return { skills: await engine.experienceCompiler.getSkills(q.tenantId) }; });
app.get("/v1/experience-compiler/experiences", async (request) => { const q = z.object({ tenantId: z.string().default("local"), tags: z.string().optional() }).parse(request.query); return { experiences: await engine.experienceCompiler.getExperiences(q.tenantId, q.tags?.split(",")) }; });
app.post("/v1/experience-compiler/compile", async (request) => { const b = auroraTenant.parse(request.body ?? {}); return { compiled: await engine.experienceCompiler.compileSkills(b.tenantId) }; });

// Sleep Cycle
app.get("/v1/sleep-cycle/cycles", async (request) => { const q = z.object({ tenantId: z.string().default("local"), limit: z.coerce.number().default(20) }).parse(request.query); return { cycles: await engine.sleepCycle.getCycles(q.tenantId, q.limit) }; });
app.post("/v1/sleep-cycle/schedule", async (request) => { const b = z.object({ tenantId: z.string().default("local"), lightCycleMinutes: z.number().optional(), deepCycleMinutes: z.number().optional(), remCycleMinutes: z.number().optional(), enabled: z.boolean().optional() }).parse(request.body); const patch: Record<string, unknown> = {}; if (b.lightCycleMinutes !== undefined) patch.lightCycleMinutes = b.lightCycleMinutes; if (b.deepCycleMinutes !== undefined) patch.deepCycleMinutes = b.deepCycleMinutes; if (b.remCycleMinutes !== undefined) patch.remCycleMinutes = b.remCycleMinutes; if (b.enabled !== undefined) patch.enabled = b.enabled; return await engine.sleepCycle.setSchedule(b.tenantId, patch as any); });

// Counterfactual Simulator
app.get("/v1/simulations", async (request) => { const q = z.object({ tenantId: z.string().default("local"), limit: z.coerce.number().default(20) }).parse(request.query); return { simulations: await engine.counterfactualSimulator.getSimulations(q.tenantId, q.limit) }; });
app.post("/v1/simulations", async (request) => { const b = z.object({ tenantId: z.string().default("local"), question: z.string(), context: z.string() }).parse(request.body); return await engine.counterfactualSimulator.createSimulation(b.tenantId, b.question, b.context); });
app.post("/v1/simulations/:simId/scenarios", async (request) => { const { simId } = z.object({ simId: z.string() }).parse(request.params); const b = z.object({ name: z.string(), description: z.string(), assumptions: z.array(z.string()), parameters: z.record(z.union([z.number(), z.string()])), estimatedEffort: z.number(), estimatedRisk: z.number(), estimatedCost: z.number(), estimatedQuality: z.number(), pros: z.array(z.string()), cons: z.array(z.string()), confidence: z.number() }).parse(request.body); return await engine.counterfactualSimulator.addScenario(simId, b); });
app.post("/v1/simulations/:simId/recommend", async (request) => { const { simId } = z.object({ simId: z.string() }).parse(request.params); return await engine.counterfactualSimulator.recommend(simId); });
app.get("/v1/simulations/calibration", async (request) => { const q = auroraTenant.parse(request.query); return await engine.counterfactualSimulator.getCalibrationAccuracy(q.tenantId); });


// ═══ Route Modules: Meta Controller + Aurora Services + Cognitive Runtime ═══
registerMetaControllerRoutes(app, engine, z, auroraTenant);
registerAuroraServiceRoutes(app, engine, z, auroraTenant);
registerCognitiveRoutes(app, engine, z, auroraTenant);

const host = process.env.HAF_HOST ?? "0.0.0.0";
const port = Number(process.env.HAF_PORT ?? 8787);
await app.listen({ host, port });

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await app.close();
  detachedWorkers.closeAttachments(); // Workers intentionally survive control-plane shutdown.
  await engine.shutdown();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
