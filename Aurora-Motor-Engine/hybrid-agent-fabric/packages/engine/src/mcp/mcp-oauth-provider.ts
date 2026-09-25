import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CredentialBrokerLike } from "../security/credential-broker.js";

interface PersistedOAuthState {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  state?: string;
}

export interface BrokerBackedMcpOAuthResumeOptions {
  tenantId: string;
  serverUrl: string;
  redirectUrl: string;
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  scopes?: string[];
  /** Exact trusted origins for OAuth discovery/token traffic outside the MCP origin. */
  authorizationServerOrigins?: string[];
}

export interface BrokerBackedMcpOAuthOptions extends BrokerBackedMcpOAuthResumeOptions {
  broker: CredentialBrokerLike;
}

/** OAuth state/tokens are encrypted by the credential broker and never projected to model/API lists. */
export class BrokerBackedMcpOAuthProvider implements OAuthClientProvider {
  private persisted: PersistedOAuthState | undefined;
  private authorizationUrlValue: URL | undefined;
  private readonly secretName: string;
  private readonly audience: string;
  private readonly stateValue: string;
  private readonly authorizationServerOrigins = new Set<string>();
  readonly redirectUrl: URL;
  readonly clientMetadata: OAuthClientMetadata;

  constructor(private readonly options: BrokerBackedMcpOAuthOptions) {
    const server = new URL(options.serverUrl);
    if (server.protocol !== "https:" && server.hostname !== "127.0.0.1" && server.hostname !== "localhost") {
      throw new Error("MCP OAuth server URL must use HTTPS except on loopback.");
    }
    this.audience = server.origin;
    this.authorizationServerOrigins.add(server.origin);
    for (const input of options.authorizationServerOrigins ?? []) {
      const origin = new URL(input);
      if (origin.protocol !== "https:" && origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost") {
        throw new Error("MCP OAuth authorization server origins must use HTTPS except on loopback.");
      }
      if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
        throw new Error("MCP OAuth authorization server allowlist entries must be exact origins.");
      }
      this.authorizationServerOrigins.add(origin.origin);
    }
    this.redirectUrl = new URL(options.redirectUrl);
    if (this.redirectUrl.protocol !== "https:" && this.redirectUrl.hostname !== "127.0.0.1" && this.redirectUrl.hostname !== "localhost") {
      throw new Error("MCP OAuth redirect URL must use HTTPS except on loopback.");
    }
    this.secretName = `HAF_MCP_OAUTH_${createHash("sha256").update(`${options.tenantId}\0${server.origin}${server.pathname}`).digest("hex").slice(0, 32).toUpperCase()}`;
    this.stateValue = randomBytes(32).toString("base64url");
    this.clientMetadata = {
      client_name: options.clientName ?? "Hybrid Agent Fabric",
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: options.clientSecret ? "client_secret_post" : "none",
      ...(options.scopes?.length ? { scope: options.scopes.join(" ") } : {}),
    };
  }

  get authorizationUrl(): URL | undefined {
    return this.authorizationUrlValue ? new URL(this.authorizationUrlValue) : undefined;
  }

  get oauthState(): string {
    return this.stateValue;
  }

  /** Internal encrypted-coordination input. Never return this through model/API surfaces. */
  resumeOptions(): BrokerBackedMcpOAuthResumeOptions {
    return {
      tenantId: this.options.tenantId,
      serverUrl: this.options.serverUrl,
      redirectUrl: this.options.redirectUrl,
      ...(this.options.clientId ? { clientId: this.options.clientId } : {}),
      ...(this.options.clientSecret ? { clientSecret: this.options.clientSecret } : {}),
      ...(this.options.clientName ? { clientName: this.options.clientName } : {}),
      ...(this.options.scopes ? { scopes: [...this.options.scopes] } : {}),
      ...(this.options.authorizationServerOrigins ? { authorizationServerOrigins: [...this.options.authorizationServerOrigins] } : {}),
    };
  }

  allowsAuthorizationServerUrl(value: URL): boolean {
    return this.authorizationServerOrigins.has(value.origin);
  }

  async matchesState(value: string): Promise<boolean> {
    const persisted = await this.load();
    const expected = persisted.state;
    return Boolean(expected && value.length === expected.length && timingSafeTextEqual(value, expected));
  }

  async clearAuthorizationAttempt(): Promise<void> {
    const state = await this.load();
    delete state.state;
    delete state.codeVerifier;
    this.persisted = state;
    await this.persist();
  }

  private async load(): Promise<PersistedOAuthState> {
    if (this.persisted) return this.persisted;
    const metadata = (await this.options.broker.list(this.options.tenantId)).find((secret) => secret.name === this.secretName);
    if (!metadata) {
      this.persisted = {};
      return this.persisted;
    }
    const lease = await this.options.broker.issueLease({
      tenantId: this.options.tenantId,
      secretId: metadata.id,
      capabilityId: "mcp.oauth",
      audience: this.audience,
      ttlMs: 30_000,
      maxUses: 1,
    });
    const raw = await this.options.broker.redeemLease({
      leaseId: lease.leaseId,
      tenantId: this.options.tenantId,
      capabilityId: "mcp.oauth",
      audience: this.audience,
    });
    const parsed = JSON.parse(raw) as PersistedOAuthState;
    this.persisted = parsed && typeof parsed === "object" ? parsed : {};
    return this.persisted;
  }

  private async persist(): Promise<void> {
    await this.options.broker.put({
      tenantId: this.options.tenantId,
      name: this.secretName,
      value: JSON.stringify(this.persisted ?? {}),
      description: `Encrypted MCP OAuth state for ${this.audience}`,
    });
  }

  private async save(patch: Partial<PersistedOAuthState>): Promise<void> {
    const current = await this.load();
    this.persisted = { ...current, ...patch };
    await this.persist();
  }

  async state(): Promise<string> {
    await this.save({ state: this.stateValue });
    return this.stateValue;
  }

  async validateState(value: string): Promise<void> {
    const persisted = await this.load();
    const expected = persisted.state ?? this.stateValue;
    if (value.length !== expected.length || !timingSafeTextEqual(value, expected)) throw new Error("MCP OAuth state validation failed.");
    delete persisted.state;
    this.persisted = persisted;
    await this.persist();
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const state = await this.load();
    if (state.clientInformation) return state.clientInformation;
    if (!this.options.clientId) return undefined;
    return {
      client_id: this.options.clientId,
      ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}),
    };
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.save({ clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.save({ tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.allowsAuthorizationServerUrl(authorizationUrl)) {
      throw new Error("MCP OAuth authorization endpoint origin is not explicitly trusted.");
    }
    this.authorizationUrlValue = new URL(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.save({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.load()).codeVerifier;
    if (!verifier) throw new Error("MCP OAuth PKCE verifier is missing.");
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.save({ discoveryState: state });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const state = await this.load();
    if (scope === "all") this.persisted = {};
    else if (scope === "client") delete state.clientInformation;
    else if (scope === "tokens") delete state.tokens;
    else if (scope === "verifier") delete state.codeVerifier;
    else if (scope === "discovery") delete state.discoveryState;
    await this.options.broker.put({
      tenantId: this.options.tenantId,
      name: this.secretName,
      value: JSON.stringify(this.persisted ?? state),
      description: `Encrypted MCP OAuth state for ${this.audience}`,
    });
  }
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
