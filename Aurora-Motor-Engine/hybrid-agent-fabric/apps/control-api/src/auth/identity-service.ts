import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type Role = "viewer" | "operator" | "admin";

export interface Identity {
  subject: string;
  email?: string;
  name?: string;
  authType: "anonymous-dev" | "api-token" | "oidc";
  systemAdmin: boolean;
  tenants: Record<string, Role>;
}

export interface WebSession {
  id: string;
  identity: Identity;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

interface OidcPending {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
  returnTo: string;
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

export interface IdentityServiceOptions {
  sessionFile: string;
  sessionSecret: string;
  sessionTtlMs?: number;
  apiToken?: string;
  authDisabled?: boolean;
  defaultTenant?: string;
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    scopes?: string[];
    tenantClaim?: string;
    roleClaim?: string;
  };
}

function base64url(value: Buffer): string { return value.toString("base64url"); }
function role(value: unknown): Role | undefined {
  return value === "admin" || value === "operator" || value === "viewer" ? value : undefined;
}
function atomicPath(path: string): string { return `${path}.${process.pid}.${randomUUID()}.tmp`; }

class EncryptedSessionStore {
  private sessions = new Map<string, WebSession>();
  private loaded = false;
  private readonly key: Buffer;
  constructor(private readonly path: string, secret: string) {
    this.key = scryptSync(secret, "haf-web-sessions-v1", 32);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const envelope = JSON.parse(await readFile(this.path, "utf8")) as { iv: string; tag: string; ciphertext: string };
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
      const records = JSON.parse(plaintext) as WebSession[];
      for (const session of records) if (new Date(session.expiresAt).getTime() > Date.now()) this.sessions.set(session.id, session);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Web session store could not be decrypted; verify HAF_SESSION_SECRET.");
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify([...this.sessions.values()]));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = atomicPath(this.path);
    await writeFile(temporary, envelope, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async create(identity: Identity, ttlMs: number): Promise<WebSession> {
    await this.load();
    const now = new Date();
    const session: WebSession = {
      id: base64url(randomBytes(32)),
      identity,
      csrfToken: base64url(randomBytes(32)),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.sessions.set(session.id, session);
    await this.save();
    return structuredClone(session);
  }

  async get(id: string): Promise<WebSession | undefined> {
    await this.load();
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      this.sessions.delete(id);
      await this.save();
      return undefined;
    }
    return structuredClone(session);
  }

  async remove(id: string): Promise<void> {
    await this.load();
    if (this.sessions.delete(id)) await this.save();
  }

  /**
   * Read a record as stored, expiry not applied and not pruned.
   *
   * `get` treats an expired session as absent and deletes it on the way out,
   * which loses the one fact an auth hook needs: that this cookie *was* a
   * session and has since lapsed. Nothing here mutates state.
   */
  async peek(id: string): Promise<WebSession | undefined> {
    await this.load();
    return this.sessions.get(id);
  }
}

export class IdentityService {
  private readonly sessions: EncryptedSessionStore;
  private readonly pending = new Map<string, OidcPending>();
  private discovery: OidcDiscovery | undefined;
  private jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  readonly sessionTtlMs: number;

  constructor(readonly options: IdentityServiceOptions) {
    this.sessions = new EncryptedSessionStore(options.sessionFile, options.sessionSecret);
    this.sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60_000;
  }

  anonymousIdentity(): Identity | undefined {
    if (!this.options.authDisabled) return undefined;
    return {
      subject: "anonymous-development-user",
      authType: "anonymous-dev",
      systemAdmin: true,
      tenants: { [this.options.defaultTenant ?? "local"]: "admin" },
    };
  }

  apiTokenIdentity(token: string | undefined): Identity | undefined {
    if (!this.options.apiToken || token !== this.options.apiToken) return undefined;
    return {
      subject: "api-token-administrator",
      authType: "api-token",
      systemAdmin: true,
      tenants: { [this.options.defaultTenant ?? "local"]: "admin" },
    };
  }

  async createSession(identity: Identity): Promise<WebSession> {
    return await this.sessions.create(identity, this.sessionTtlMs);
  }
  async getSession(id: string | undefined): Promise<WebSession | undefined> {
    return id ? await this.sessions.get(id) : undefined;
  }

  /**
   * Resolve a session cookie, keeping "expired" distinguishable from "unknown".
   *
   * `getSession` returns `undefined` for both, which is the right answer for
   * most callers and the wrong one for the auth hook: a client holding a cookie
   * whose session lapsed needs "log in again", and a client with no cookie needs
   * "you were never logged in". Answering both the same way is what makes a
   * client retry a dead credential forever.
   *
   * The expired record is read without being deleted: an expired session is
   * already invisible to `getSession`, and deleting it here would make the
   * condition unobservable after the first request.
   */
  async lookupSession(id: string | undefined): Promise<
    { status: "none" } | { status: "expired"; expiresAt: string } | { status: "active"; session: WebSession }
  > {
    if (!id) return { status: "none" };
    const session = await this.sessions.peek(id);
    if (!session) return { status: "none" };
    const expiresAt = new Date(session.expiresAt).getTime();
    if (expiresAt <= Date.now()) return { status: "expired", expiresAt: session.expiresAt };
    return { status: "active", session: structuredClone(session) };
  }
  async logout(id: string | undefined): Promise<void> {
    if (id) await this.sessions.remove(id);
  }

  async oidcStart(returnTo = "/"): Promise<{ url: string; state: string }> {
    if (!this.options.oidc) throw new Error("OIDC is not configured.");
    const discovery = await this.getDiscovery();
    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
    this.pending.set(state, { state, nonce, verifier, expiresAt: Date.now() + 10 * 60_000, returnTo: safeReturnTo });
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.options.oidc.clientId);
    url.searchParams.set("redirect_uri", this.options.oidc.redirectUri);
    url.searchParams.set("scope", (this.options.oidc.scopes ?? ["openid", "profile", "email"]).join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), state };
  }

  async oidcCallback(code: string, state: string): Promise<{ session: WebSession; returnTo: string }> {
    if (!this.options.oidc) throw new Error("OIDC is not configured.");
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt <= Date.now()) throw new Error("OIDC state is missing or expired.");
    const discovery = await this.getDiscovery();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.options.oidc.redirectUri,
      client_id: this.options.oidc.clientId,
      code_verifier: pending.verifier,
    });
    if (this.options.oidc.clientSecret) form.set("client_secret", this.options.oidc.clientSecret);
    const response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!response.ok) throw new Error(`OIDC token exchange failed with HTTP ${response.status}.`);
    const token = await response.json() as { id_token?: string };
    if (!token.id_token) throw new Error("OIDC token response omitted id_token.");
    this.jwks ??= createRemoteJWKSet(new URL(discovery.jwks_uri));
    const verified = await jwtVerify(token.id_token, this.jwks, {
      issuer: discovery.issuer,
      audience: this.options.oidc.clientId,
    });
    if (verified.payload.nonce !== pending.nonce) throw new Error("OIDC nonce mismatch.");
    const identity = this.identityFromClaims(verified.payload);
    return { session: await this.createSession(identity), returnTo: pending.returnTo };
  }

  identityFromClaims(claims: JWTPayload): Identity {
    const oidc = this.options.oidc;
    if (!claims.sub) throw new Error("OIDC identity has no subject.");
    const defaultTenant = this.options.defaultTenant ?? "local";
    const tenants: Record<string, Role> = {};
    const tenantClaim = oidc?.tenantClaim ? claims[oidc.tenantClaim] : claims.haf_tenants;
    if (tenantClaim && typeof tenantClaim === "object" && !Array.isArray(tenantClaim)) {
      for (const [tenant, rawRole] of Object.entries(tenantClaim)) {
        const parsed = role(rawRole);
        if (parsed) tenants[tenant] = parsed;
      }
    } else if (Array.isArray(tenantClaim)) {
      for (const tenant of tenantClaim) if (typeof tenant === "string") tenants[tenant] = "viewer";
    }
    const roleClaim = oidc?.roleClaim ? claims[oidc.roleClaim] : claims.roles;
    const roles = Array.isArray(roleClaim) ? roleClaim.map(String) : typeof roleClaim === "string" ? [roleClaim] : [];
    const globalRole = roles.includes("haf:admin") ? "admin" : roles.includes("haf:operator") ? "operator" : roles.includes("haf:viewer") ? "viewer" : undefined;
    if (!Object.keys(tenants).length && globalRole) tenants[defaultTenant] = globalRole;
    return {
      subject: claims.sub,
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(typeof claims.name === "string" ? { name: claims.name } : {}),
      authType: "oidc",
      systemAdmin: roles.includes("haf:system-admin"),
      tenants,
    };
  }

  roleFor(identity: Identity, tenantId: string): Role | undefined {
    return identity.systemAdmin ? "admin" : identity.tenants[tenantId];
  }

  private async getDiscovery(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    const issuer = this.options.oidc!.issuer.replace(/\/$/, "");
    const response = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}.`);
    const discovery = await response.json() as Partial<OidcDiscovery>;
    if (!discovery.authorization_endpoint || !discovery.token_endpoint || !discovery.jwks_uri || !discovery.issuer) throw new Error("OIDC discovery document is incomplete.");
    if (discovery.issuer !== issuer) throw new Error("OIDC issuer mismatch in discovery document.");
    this.discovery = discovery as OidcDiscovery;
    return this.discovery;
  }
}

export function roleAllows(roleValue: Role | undefined, required: Role): boolean {
  const rank: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };
  return roleValue !== undefined && rank[roleValue] >= rank[required];
}
