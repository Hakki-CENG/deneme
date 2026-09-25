export type CredentialFailureDisposition = "none" | "cooldown" | "disable";

export interface ModelProviderErrorOptions {
  providerId: string;
  status?: number;
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  credentialDisposition?: CredentialFailureDisposition;
  cause?: unknown;
}

/**
 * A provider-safe error envelope. It deliberately carries classification metadata,
 * not request headers, credentials, or an unbounded upstream response body.
 */
export class ModelProviderError extends Error {
  readonly providerId: string;
  readonly status: number | undefined;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly credentialDisposition: CredentialFailureDisposition;

  constructor(message: string, options: ModelProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelProviderError";
    this.providerId = options.providerId;
    this.status = options.status;
    this.code = options.code ?? (options.status ? `http_${options.status}` : "provider_error");
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.credentialDisposition = options.credentialDisposition ?? "none";
  }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), 24 * 60 * 60_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.min(date - now, 24 * 60 * 60_000));
}

function boundedProviderMessage(providerId: string, status: number, body: string): string {
  // Upstream bodies can contain reflected request content. Keep only a compact,
  // single-line diagnostic and strip common credential-shaped values.
  const safe = body
    .replace(/[\r\n\t]+/g, " ")
    .replace(/("(?:api[_-]?key|token|authorization|credential)"\s*:\s*")[^"]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|key|token|bearer)[-_][A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return `${providerId} model API returned HTTP ${status}${safe ? `: ${safe}` : "."}`;
}

export async function modelHttpError(providerId: string, response: Response): Promise<ModelProviderError> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // Classification must not fail because an error response body is unreadable.
  }
  const status = response.status;
  const rateLimited = status === 429;
  const transient = status === 408 || status === 409 || status === 425 || rateLimited || status >= 500;
  const credentialRejected = status === 401 || status === 403;
  const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
  return new ModelProviderError(boundedProviderMessage(providerId, status, body), {
    providerId,
    status,
    code: rateLimited ? "rate_limited" : credentialRejected ? "credential_rejected" : transient ? "transient_http" : `http_${status}`,
    retryable: transient,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    credentialDisposition: credentialRejected ? "disable" : transient ? "cooldown" : "none",
  });
}

export function classifyModelFailure(providerId: string, error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ModelProviderError("Model request was cancelled.", {
      providerId,
      code: "cancelled",
      retryable: false,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ModelProviderError(`Model provider ${providerId} failed before producing a response: ${message.slice(0, 500)}`, {
    providerId,
    code: "transport_error",
    retryable: true,
    credentialDisposition: "cooldown",
    cause: error,
  });
}
