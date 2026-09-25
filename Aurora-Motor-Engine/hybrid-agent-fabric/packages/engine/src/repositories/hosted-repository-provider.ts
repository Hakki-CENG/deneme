import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeUrl } from "../capabilities/web.js";
import type { CredentialBrokerLike } from "../security/credential-broker.js";
import type { GitHubAppInstallationCredentialSource } from "./github-app-manager.js";
import { atomicWrite } from "../util/atomic-file.js";

export type HostedRepositoryKind = "github" | "gitlab";
export type HostedRepositoryAuthStyle = "bearer" | "private-token";
export type GitHubAccountMode = "user" | "installation";

interface HostedRepositoryProviderRecord {
  id: string;
  tenantId: string;
  name: string;
  kind: HostedRepositoryKind;
  apiBase: string;
  cloneOrigin: string;
  credentialSecretId?: string;
  githubAppInstallationId?: string;
  authStyle: HostedRepositoryAuthStyle;
  githubAccountMode?: GitHubAccountMode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HostedRepositoryProviderView {
  id: string;
  tenantId: string;
  name: string;
  kind: HostedRepositoryKind;
  apiBase: string;
  cloneOrigin: string;
  credentialSecretId?: string;
  githubAppInstallationId?: string;
  authSource: "secret" | "github_app";
  authStyle: HostedRepositoryAuthStyle;
  githubAccountMode?: GitHubAccountMode;
  enabled: boolean;
  credentialConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HostedRepositorySummary {
  providerId: string;
  repositoryId: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  webUrl: string;
  updatedAt?: string;
}

export interface HostedRepositoryFile {
  providerId: string;
  repositoryId: string;
  fullName: string;
  path: string;
  ref: string;
  remoteVersion: string;
  contentSha256: string;
  content: string;
  bytes: number;
}

export interface HostedReviewSummary {
  id: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  headSha?: string;
  author?: string;
  updatedAt?: string;
}

interface HostedRepositoryLink {
  sessionId: string;
  tenantId: string;
  providerId: string;
  repositoryId: string;
  fullName: string;
  defaultBranch: string;
  importedHead: string;
  createdAt: string;
  updatedAt: string;
}

export type HostedReviewOperationKind = "create" | "comment" | "close" | "merge";
export interface HostedReviewOperation {
  id: string;
  tenantId: string;
  providerId: string;
  repositoryId: string;
  kind: HostedReviewOperationKind;
  inputSha256: string;
  idempotencyKeyHash: string;
  status: "pending" | "succeeded" | "failed" | "uncertain";
  reviewNumber?: number;
  remoteId?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}
interface RegistryState {
  schemaVersion: 1;
  providers: HostedRepositoryProviderRecord[];
  links: HostedRepositoryLink[];
  operations: HostedReviewOperation[];
}

export interface HostedRepositoryProviderOptions {
  rootPath: string;
  credentials: CredentialBrokerLike;
  githubApps?: GitHubAppInstallationCredentialSource;
  fetch?: typeof fetch;
  urlGuard?: (url: string) => Promise<URL>;
  localHead?: (workspacePath: string) => Promise<string>;
}

const MAX_JSON_BYTES = 8 * 1024 * 1024;
class HostedRepositoryHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "HostedRepositoryHttpError"; }
}

/** Tenant-scoped GitHub/GitLab account registry with broker-leased credentials. */
export class HostedRepositoryProviderRegistry {
  private state: RegistryState = { schemaVersion: 1, providers: [], links: [], operations: [] };
  private loaded = false;
  private readonly fetchImpl: typeof fetch;
  private readonly urlGuard: (url: string) => Promise<URL>;
  private readonly localHead: (workspacePath: string) => Promise<string>;

  constructor(private readonly options: HostedRepositoryProviderOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.urlGuard = options.urlGuard ?? assertSafeUrl;
    this.localHead = options.localHead ?? defaultLocalHead;
  }

  async add(input: {
    tenantId: string;
    name: string;
    kind: HostedRepositoryKind;
    credentialSecretId?: string;
    githubAppInstallationId?: string;
    apiBase?: string;
    cloneOrigin?: string;
    authStyle?: HostedRepositoryAuthStyle;
    githubAccountMode?: GitHubAccountMode;
  }): Promise<HostedRepositoryProviderView> {
    await this.load();
    const name = input.name.trim();
    if (!name || name.length > 200) throw new Error("Hosted repository provider name is invalid.");
    if (this.state.providers.some((item) => item.tenantId === input.tenantId && item.name.toLowerCase() === name.toLowerCase())) throw new Error("Hosted repository provider name already exists in tenant.");
    if (Boolean(input.credentialSecretId) === Boolean(input.githubAppInstallationId)) {
      throw new Error("Hosted repository provider requires exactly one secret or GitHub App installation credential source.");
    }
    let secretId: string | undefined;
    if (input.credentialSecretId) {
      const secret = (await this.options.credentials.list(input.tenantId)).find((item) => item.id === input.credentialSecretId);
      if (!secret) throw new Error("Hosted repository credential secret does not exist in tenant.");
      secretId = secret.id;
    } else {
      if (input.kind !== "github" || !this.options.githubApps) throw new Error("GitHub App installation credentials are unavailable for this provider kind.");
      const installation = await this.options.githubApps.installation(input.githubAppInstallationId!, input.tenantId);
      if (installation.status !== "active" || !installation.credentialConfigured) throw new Error("GitHub App installation credential is not active.");
    }
    const defaults = input.kind === "github"
      ? { apiBase: "https://api.github.com", cloneOrigin: "https://github.com", authStyle: "bearer" as const }
      : { apiBase: "https://gitlab.com/api/v4", cloneOrigin: "https://gitlab.com", authStyle: "bearer" as const };
    const apiBase = await normalizedPublicBase(input.apiBase ?? defaults.apiBase, this.urlGuard, true);
    const cloneOrigin = await normalizedPublicBase(input.cloneOrigin ?? defaults.cloneOrigin, this.urlGuard, false);
    const authStyle = input.authStyle ?? defaults.authStyle;
    if (input.kind === "github" && authStyle !== "bearer") throw new Error("GitHub hosted integration requires bearer authentication.");
    const now = new Date().toISOString();
    const record: HostedRepositoryProviderRecord = {
      id: randomUUID(), tenantId: input.tenantId, name, kind: input.kind,
      apiBase, cloneOrigin,
      ...(secretId ? { credentialSecretId: secretId } : {}),
      ...(input.githubAppInstallationId ? { githubAppInstallationId: input.githubAppInstallationId } : {}),
      authStyle,
      ...(input.kind === "github" ? { githubAccountMode: input.githubAppInstallationId ? "installation" : input.githubAccountMode ?? "user" } : {}),
      enabled: true, createdAt: now, updatedAt: now,
    };
    this.state.providers.push(record);
    await this.save();
    return await this.view(record);
  }

  async list(tenantId: string): Promise<HostedRepositoryProviderView[]> {
    await this.load();
    return await Promise.all(this.state.providers.filter((item) => item.tenantId === tenantId).map((item) => this.view(item)));
  }

  async setEnabled(id: string, tenantId: string, enabled: boolean): Promise<HostedRepositoryProviderView> {
    const record = await this.record(id, tenantId);
    record.enabled = enabled; record.updatedAt = new Date().toISOString(); await this.save();
    return await this.view(record);
  }

  async remove(id: string, tenantId: string): Promise<boolean> {
    await this.load();
    const before = this.state.providers.length;
    this.state.providers = this.state.providers.filter((item) => !(item.id === id && item.tenantId === tenantId));
    if (before === this.state.providers.length) return false;
    this.state.links = this.state.links.filter((item) => !(item.providerId === id && item.tenantId === tenantId));
    await this.save(); return true;
  }

  async repositories(id: string, tenantId: string, limit = 200): Promise<HostedRepositorySummary[]> {
    const provider = await this.enabledRecord(id, tenantId);
    const output: HostedRepositorySummary[] = [];
    const pageLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    for (let page = 1; page <= 5 && output.length < pageLimit; page++) {
      const path = provider.kind === "github"
        ? provider.githubAccountMode === "installation"
          ? `installation/repositories?per_page=100&page=${page}`
          : `user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`
        : `projects?membership=true&simple=true&per_page=100&page=${page}&order_by=updated_at&sort=desc`;
      const body = await this.api(provider, path);
      const rows = provider.kind === "github" && !Array.isArray(body) ? body.repositories : body;
      if (!Array.isArray(rows)) throw new Error("Hosted repository provider returned an invalid repository list.");
      output.push(...rows.map((item) => normalizeRepository(provider, item)).filter((item): item is HostedRepositorySummary => Boolean(item)));
      if (rows.length < 100) break;
    }
    return output.slice(0, pageLimit);
  }

  async repository(id: string, tenantId: string, repositoryId: string): Promise<HostedRepositorySummary> {
    const provider = await this.enabledRecord(id, tenantId);
    const path = provider.kind === "github" ? `repositories/${numericId(repositoryId)}` : `projects/${encodeURIComponent(repositoryId)}`;
    const value = await this.api(provider, path);
    const repository = normalizeRepository(provider, value);
    if (!repository) throw new Error("Hosted repository provider returned invalid repository metadata.");
    return repository;
  }

  async readFile(id: string, tenantId: string, repositoryId: string, requestedPath: string, requestedRef: string): Promise<HostedRepositoryFile> {
    const provider = await this.enabledRecord(id, tenantId);
    const repository = await this.repository(id, tenantId, repositoryId);
    const path = safeHostedFilePath(requestedPath);
    const ref = safeHostedRef(requestedRef);
    let body: any;
    if (provider.kind === "github") {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      body = await this.api(provider, `${githubRepoPath(repository.fullName, `contents/${encodedPath}`)}?ref=${encodeURIComponent(ref)}`);
    } else {
      body = await this.api(provider, `projects/${encodeURIComponent(repository.repositoryId)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
    }
    const type = provider.kind === "github" ? body?.type : "file";
    const encoding = String(body?.encoding ?? "").toLowerCase();
    const encoded = typeof body?.content === "string" ? body.content.replace(/\s+/g, "") : "";
    const declaredSize = Number(body?.size);
    const remoteVersion = String(provider.kind === "github" ? body?.sha ?? "" : body?.blob_id ?? body?.last_commit_id ?? "");
    if (type !== "file" || encoding !== "base64" || !encoded || encoded.length > 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error("Hosted repository file response is invalid.");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.length > 512 * 1024 || (Number.isFinite(declaredSize) && declaredSize !== bytes.length)) {
      throw new Error("Hosted repository file exceeds its safety bound or size contract.");
    }
    if (!/^[a-f0-9]{40,64}$/i.test(remoteVersion)) throw new Error("Hosted repository file version is invalid.");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("Hosted repository file must be UTF-8 text."); }
    return {
      providerId: provider.id, repositoryId: repository.repositoryId, fullName: repository.fullName,
      path, ref, remoteVersion, contentSha256: sha256(content), content, bytes: bytes.length,
    };
  }

  async reviews(id: string, tenantId: string, repositoryId: string): Promise<HostedReviewSummary[]> {
    const provider = await this.enabledRecord(id, tenantId);
    const repository = await this.repository(id, tenantId, repositoryId);
    let body: any;
    if (provider.kind === "github") {
      const [owner, repo, ...extra] = repository.fullName.split("/");
      if (!owner || !repo || extra.length) throw new Error("GitHub repository full name is invalid.");
      body = await this.api(provider, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100`);
    } else {
      body = await this.api(provider, `projects/${encodeURIComponent(repository.repositoryId)}/merge_requests?state=opened&per_page=100`);
    }
    if (!Array.isArray(body)) throw new Error("Hosted repository provider returned an invalid review list.");
    return body.map((item) => normalizeReview(provider.kind, item)).filter((item): item is HostedReviewSummary => Boolean(item)).slice(0, 100);
  }

  async createReview(input: {
    providerId: string; tenantId: string; repositoryId: string; title: string; body?: string;
    sourceBranch: string; targetBranch: string; draft?: boolean; idempotencyKey: string;
  }): Promise<HostedReviewOperation> {
    const title = boundedInput(input.title, 300, "review title"), body = input.body ? boundedInput(input.body, 100_000, "review body") : undefined;
    const sourceBranch = safeBranch(input.sourceBranch), targetBranch = safeBranch(input.targetBranch);
    const provider = await this.enabledRecord(input.providerId, input.tenantId);
    const repository = await this.repository(input.providerId, input.tenantId, input.repositoryId);
    const path = provider.kind === "github"
      ? githubRepoPath(repository.fullName, "pulls")
      : `projects/${encodeURIComponent(repository.repositoryId)}/merge_requests`;
    const payload = provider.kind === "github"
      ? { title, head: sourceBranch, base: targetBranch, ...(body ? { body } : {}), draft: input.draft === true }
      : { title: input.draft ? `Draft: ${title}` : title, source_branch: sourceBranch, target_branch: targetBranch, ...(body ? { description: body } : {}), remove_source_branch: false };
    return await this.mutate(provider, repository.repositoryId, "create", input.idempotencyKey, payload, async () => {
      const result = await this.api(provider, path, { method: "POST", body: payload });
      const number = Number(provider.kind === "github" ? result.number : result.iid);
      if (!Number.isInteger(number) || number < 1) throw new Error("Hosted review creation returned no review number.");
      return { reviewNumber: number, remoteId: String(result.id ?? number) };
    });
  }

  async commentReview(input: { providerId: string; tenantId: string; repositoryId: string; reviewNumber: number; body: string; idempotencyKey: string }): Promise<HostedReviewOperation> {
    const body = boundedInput(input.body, 100_000, "review comment"), number = positiveNumber(input.reviewNumber);
    const provider = await this.enabledRecord(input.providerId, input.tenantId);
    const repository = await this.repository(input.providerId, input.tenantId, input.repositoryId);
    const path = provider.kind === "github"
      ? githubRepoPath(repository.fullName, `issues/${number}/comments`)
      : `projects/${encodeURIComponent(repository.repositoryId)}/merge_requests/${number}/notes`;
    const payload = { body };
    return await this.mutate(provider, repository.repositoryId, "comment", input.idempotencyKey, { number, body }, async () => {
      const result = await this.api(provider, path, { method: "POST", body: provider.kind === "github" ? payload : { body } });
      const remoteId = String(result.id ?? "");
      return { reviewNumber: number, ...(remoteId ? { remoteId } : {}) };
    });
  }

  async closeReview(input: { providerId: string; tenantId: string; repositoryId: string; reviewNumber: number; idempotencyKey: string }): Promise<HostedReviewOperation> {
    const number = positiveNumber(input.reviewNumber), provider = await this.enabledRecord(input.providerId, input.tenantId);
    const repository = await this.repository(input.providerId, input.tenantId, input.repositoryId);
    const path = provider.kind === "github"
      ? githubRepoPath(repository.fullName, `pulls/${number}`)
      : `projects/${encodeURIComponent(repository.repositoryId)}/merge_requests/${number}`;
    const payload = provider.kind === "github" ? { state: "closed" } : { state_event: "close" };
    return await this.mutate(provider, repository.repositoryId, "close", input.idempotencyKey, { number }, async () => {
      const result = await this.api(provider, path, { method: provider.kind === "github" ? "PATCH" : "PUT", body: payload });
      const remoteId = String(result.id ?? "");
      return { reviewNumber: number, ...(remoteId ? { remoteId } : {}) };
    });
  }

  async mergeReview(input: {
    providerId: string; tenantId: string; repositoryId: string; reviewNumber: number;
    expectedHeadSha: string; method?: "merge" | "squash" | "rebase"; idempotencyKey: string;
  }): Promise<HostedReviewOperation> {
    const number = positiveNumber(input.reviewNumber), sha = input.expectedHeadSha.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("Expected review HEAD SHA is invalid.");
    const provider = await this.enabledRecord(input.providerId, input.tenantId);
    const repository = await this.repository(input.providerId, input.tenantId, input.repositoryId);
    const path = provider.kind === "github"
      ? githubRepoPath(repository.fullName, `pulls/${number}/merge`)
      : `projects/${encodeURIComponent(repository.repositoryId)}/merge_requests/${number}/merge`;
    const payload = provider.kind === "github"
      ? { sha, merge_method: input.method ?? "merge" }
      : { sha, merge_when_pipeline_succeeds: false, should_remove_source_branch: false, squash: input.method === "squash" };
    return await this.mutate(provider, repository.repositoryId, "merge", input.idempotencyKey, { number, sha, method: input.method ?? "merge" }, async () => {
      const result = await this.api(provider, path, { method: "PUT", body: payload });
      if (provider.kind === "github" && result.merged !== true) throw new HostedRepositoryHttpError(409, "GitHub reported the pull request was not merged.");
      const remoteId = String(result.sha ?? result.id ?? "");
      return { reviewNumber: number, ...(remoteId ? { remoteId } : {}) };
    });
  }

  async listOperations(tenantId: string, providerId?: string): Promise<HostedReviewOperation[]> {
    await this.load();
    return this.state.operations.filter(item => item.tenantId === tenantId && (!providerId || item.providerId === providerId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 1000).map(item => structuredClone(item));
  }

  async resolveImport(id: string, tenantId: string, repositoryId: string): Promise<{ repository: HostedRepositorySummary; credentialSecretId: string; credentialUsername: string }> {
    const provider = await this.enabledRecord(id, tenantId);
    const repository = await this.repository(id, tenantId, repositoryId);
    const clone = new URL(repository.cloneUrl);
    if (clone.protocol !== "https:" || clone.origin !== provider.cloneOrigin || clone.username || clone.password || clone.search || clone.hash) {
      throw new Error("Hosted repository clone URL escaped its configured origin.");
    }
    const credentialSecretId = provider.githubAppInstallationId
      ? (await this.githubAppCredential(provider)).secretId
      : provider.credentialSecretId;
    if (!credentialSecretId) throw new Error("Hosted repository credential is missing.");
    return { repository, credentialSecretId, credentialUsername: provider.kind === "github" ? "x-access-token" : "oauth2" };
  }

  async linkSession(input: { sessionId: string; tenantId: string; providerId: string; repository: HostedRepositorySummary; importedHead: string }): Promise<void> {
    await this.load();
    const existing = this.state.links.find((item) => item.sessionId === input.sessionId && item.tenantId === input.tenantId);
    const now = new Date().toISOString();
    const value: HostedRepositoryLink = {
      sessionId: input.sessionId, tenantId: input.tenantId, providerId: input.providerId,
      repositoryId: input.repository.repositoryId, fullName: input.repository.fullName,
      defaultBranch: input.repository.defaultBranch, importedHead: input.importedHead,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    if (existing) this.state.links[this.state.links.indexOf(existing)] = value;
    else this.state.links.push(value);
    await this.save();
  }

  async syncStatus(sessionId: string, tenantId: string, workspacePath: string): Promise<{
    linked: boolean; providerId?: string; repositoryId?: string; fullName?: string; branch?: string;
    importedHead?: string; localHead?: string; remoteHead?: string; state?: "up_to_date" | "local_changed" | "remote_changed" | "diverged_or_advanced";
  }> {
    await this.load();
    const link = this.state.links.find((item) => item.sessionId === sessionId && item.tenantId === tenantId);
    if (!link) return { linked: false };
    const provider = await this.enabledRecord(link.providerId, tenantId);
    const localHead = await this.localHead(workspacePath);
    const remoteHead = await this.remoteHead(provider, link);
    const state = localHead === remoteHead ? "up_to_date"
      : localHead === link.importedHead ? "remote_changed"
      : remoteHead === link.importedHead ? "local_changed"
      : "diverged_or_advanced";
    return {
      linked: true, providerId: provider.id, repositoryId: link.repositoryId, fullName: link.fullName,
      branch: link.defaultBranch, importedHead: link.importedHead, localHead, remoteHead, state,
    };
  }

  private async mutate(
    provider: HostedRepositoryProviderRecord,
    repositoryId: string,
    kind: HostedReviewOperationKind,
    idempotencyKey: string,
    input: unknown,
    operation: () => Promise<{ reviewNumber?: number; remoteId?: string }>,
  ): Promise<HostedReviewOperation> {
    await this.load();
    if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(idempotencyKey)) throw new Error("Hosted review idempotency key is invalid.");
    const idempotencyKeyHash = sha256(`${provider.tenantId}\0${provider.id}\0${repositoryId}\0${idempotencyKey}`);
    const existing = this.state.operations.find(item => item.providerId === provider.id && item.tenantId === provider.tenantId && item.idempotencyKeyHash === idempotencyKeyHash);
    if (existing) return structuredClone(existing);
    const now = new Date().toISOString();
    const record: HostedReviewOperation = {
      id: randomUUID(), tenantId: provider.tenantId, providerId: provider.id, repositoryId, kind,
      inputSha256: sha256(canonicalJson(input)), idempotencyKeyHash, status: "pending", createdAt: now, updatedAt: now,
    };
    this.state.operations.push(record); await this.save();
    try {
      const result = await operation();
      record.status = "succeeded";
      if (result.reviewNumber !== undefined) record.reviewNumber = result.reviewNumber;
      if (result.remoteId) record.remoteId = result.remoteId.slice(0, 300);
      delete record.errorCode;
    } catch (error) {
      const deterministic = error instanceof HostedRepositoryHttpError && error.status >= 400 && error.status < 500
        && ![408, 409, 425, 429].includes(error.status);
      record.status = deterministic ? "failed" : "uncertain";
      record.errorCode = error instanceof HostedRepositoryHttpError ? `http_${error.status}` : "transport_or_response_error";
      record.updatedAt = new Date().toISOString(); await this.save();
      throw error;
    }
    record.updatedAt = new Date().toISOString(); await this.save(); return structuredClone(record);
  }

  private async remoteHead(provider: HostedRepositoryProviderRecord, link: HostedRepositoryLink): Promise<string> {
    let value: any;
    if (provider.kind === "github") {
      const [owner, repo] = link.fullName.split("/");
      value = await this.api(provider, `repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/branches/${encodeURIComponent(link.defaultBranch)}`);
      const head = value?.commit?.sha;
      if (typeof head === "string" && /^[a-f0-9]{40,64}$/i.test(head)) return head;
    } else {
      value = await this.api(provider, `projects/${encodeURIComponent(link.repositoryId)}/repository/branches/${encodeURIComponent(link.defaultBranch)}`);
      const head = value?.commit?.id;
      if (typeof head === "string" && /^[a-f0-9]{40,64}$/i.test(head)) return head;
    }
    throw new Error("Hosted repository branch HEAD is invalid.");
  }

  private async api(provider: HostedRepositoryProviderRecord, path: string, options: { method?: "GET" | "POST" | "PUT" | "PATCH"; body?: unknown } = {}): Promise<any> {
    const base = new URL(provider.apiBase.endsWith("/") ? provider.apiBase : `${provider.apiBase}/`);
    const target = await this.urlGuard(new URL(path.replace(/^\/+/, ""), base).toString());
    const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    if (target.origin !== base.origin || !target.pathname.startsWith(prefix) || target.username || target.password) throw new Error("Hosted repository API request escaped its configured boundary.");
    let token = provider.githubAppInstallationId
      ? await this.githubAppToken(provider)
      : await this.staticToken(provider, base.origin);
    try {
      const headers: Record<string, string> = { accept: "application/json", "user-agent": "Hybrid-Agent-Fabric/1.38" };
      if (provider.authStyle === "private-token") headers["private-token"] = token;
      else headers.authorization = `Bearer ${token}`;
      if (provider.kind === "github") {
        headers.accept = "application/vnd.github+json";
        headers["x-github-api-version"] = "2022-11-28";
      }
      if (options.body !== undefined) headers["content-type"] = "application/json";
      const response = await this.fetchImpl(target, {
        method: options.method ?? "GET", headers, redirect: "manual",
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        throw new HostedRepositoryHttpError(response.status, "Hosted repository API redirects are forbidden.");
      }
      const text = await boundedText(response, MAX_JSON_BYTES);
      if (!response.ok) throw new HostedRepositoryHttpError(response.status, `Hosted repository API request failed with HTTP ${response.status}.`);
      if (!text) return {};
      try { return JSON.parse(text); }
      catch { throw new Error("Hosted repository API returned invalid JSON."); }
    } finally { token = ""; }
  }

  private async staticToken(provider: HostedRepositoryProviderRecord, audience: string): Promise<string> {
    if (!provider.credentialSecretId) throw new Error("Hosted repository credential is missing.");
    const metadata = (await this.options.credentials.list(provider.tenantId)).find((item) => item.id === provider.credentialSecretId);
    if (!metadata) throw new Error("Hosted repository credential is missing.");
    const lease = await this.options.credentials.issueLease({
      tenantId: provider.tenantId, secretId: metadata.id, capabilityId: "repository.hosted", audience, ttlMs: 30_000, maxUses: 1,
    });
    return await this.options.credentials.redeemLease({
      leaseId: lease.leaseId, tenantId: provider.tenantId, capabilityId: "repository.hosted", audience,
    });
  }

  private async githubAppToken(provider: HostedRepositoryProviderRecord): Promise<string> {
    if (!provider.githubAppInstallationId || !this.options.githubApps) throw new Error("GitHub App installation credential source is unavailable.");
    return await this.options.githubApps.accessToken(provider.githubAppInstallationId, provider.tenantId);
  }

  private async githubAppCredential(provider: HostedRepositoryProviderRecord): Promise<{ secretId: string; expiresAt: string }> {
    if (!provider.githubAppInstallationId || !this.options.githubApps) throw new Error("GitHub App installation credential source is unavailable.");
    return await this.options.githubApps.accessCredential(provider.githubAppInstallationId, provider.tenantId);
  }

  private async enabledRecord(id: string, tenantId: string): Promise<HostedRepositoryProviderRecord> {
    const record = await this.record(id, tenantId);
    if (!record.enabled) throw new Error("Hosted repository provider is disabled.");
    return record;
  }

  private async record(id: string, tenantId: string): Promise<HostedRepositoryProviderRecord> {
    await this.load();
    const record = this.state.providers.find((item) => item.id === id && item.tenantId === tenantId);
    if (!record) throw new Error("Hosted repository provider not found in tenant.");
    return record;
  }

  private async view(record: HostedRepositoryProviderRecord): Promise<HostedRepositoryProviderView> {
    const configured = record.githubAppInstallationId && this.options.githubApps
      ? (await this.options.githubApps.installation(record.githubAppInstallationId, record.tenantId).catch(() => undefined))?.credentialConfigured === true
      : (await this.options.credentials.list(record.tenantId)).some((item) => item.id === record.credentialSecretId);
    return {
      ...structuredClone(record),
      authSource: record.githubAppInstallationId ? "github_app" : "secret",
      credentialConfigured: configured,
    };
  }

  private get path(): string { return join(this.options.rootPath, "repositories", "hosted-providers.json"); }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      if (Buffer.byteLength(raw) > MAX_JSON_BYTES) throw new Error("Hosted repository registry exceeds its safety bound.");
      this.state = validateState(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }
  private async save(): Promise<void> {
    if (this.state.operations.length > 100_000) this.state.operations.splice(0, this.state.operations.length - 100_000);
    const encoded = `${JSON.stringify(this.state, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) throw new Error("Hosted repository registry exceeds its safety bound.");
    await atomicWrite(this.path, encoded);
  }
}

async function normalizedPublicBase(value: string, guard: (url: string) => Promise<URL>, allowPath: boolean): Promise<string> {
  const url = await guard(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (!allowPath && url.pathname !== "/")) {
    throw new Error("Hosted repository endpoint must be credential-free public HTTPS.");
  }
  return allowPath ? url.toString().replace(/\/$/, "") : url.origin;
}
function normalizeRepository(provider: HostedRepositoryProviderRecord, value: any): HostedRepositorySummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const repositoryId = String(value.id ?? "").trim();
  const fullName = String(provider.kind === "github" ? value.full_name ?? "" : value.path_with_namespace ?? "").trim();
  const cloneUrl = String(provider.kind === "github" ? value.clone_url ?? "" : value.http_url_to_repo ?? "").trim();
  const webUrl = String(provider.kind === "github" ? value.html_url ?? "" : value.web_url ?? "").trim();
  const defaultBranch = String(value.default_branch ?? "").trim();
  if (!repositoryId || !fullName || !cloneUrl || !webUrl || !defaultBranch || fullName.length > 500 || defaultBranch.length > 200) return undefined;
  return {
    providerId: provider.id, repositoryId, fullName, private: provider.kind === "github" ? value.private === true : value.visibility !== "public",
    defaultBranch, cloneUrl, webUrl,
    ...(typeof value.updated_at === "string" ? { updatedAt: value.updated_at } : {}),
  };
}
function normalizeReview(kind: HostedRepositoryKind, value: any): HostedReviewSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const number = Number(kind === "github" ? value.number : value.iid);
  const id = String(value.id ?? number);
  const title = String(value.title ?? "").slice(0, 1000);
  const sourceBranch = String(kind === "github" ? value.head?.ref ?? "" : value.source_branch ?? "").slice(0, 300);
  const targetBranch = String(kind === "github" ? value.base?.ref ?? "" : value.target_branch ?? "").slice(0, 300);
  const webUrl = String(kind === "github" ? value.html_url ?? "" : value.web_url ?? "");
  if (!Number.isInteger(number) || number < 1 || !title || !sourceBranch || !targetBranch || !webUrl) return undefined;
  const author = kind === "github" ? value.user?.login : value.author?.username;
  return {
    id, number, title, state: String(value.state ?? "open"), draft: value.draft === true,
    sourceBranch, targetBranch, webUrl,
    ...(typeof (kind === "github" ? value.head?.sha : value.sha) === "string" && /^[a-f0-9]{40,64}$/i.test(kind === "github" ? value.head.sha : value.sha) ? { headSha: String(kind === "github" ? value.head.sha : value.sha) } : {}),
    ...(typeof author === "string" ? { author } : {}),
    ...(typeof value.updated_at === "string" ? { updatedAt: value.updated_at } : {}),
  };
}
function numericId(value: string): string {
  if (!/^\d{1,30}$/.test(value)) throw new Error("GitHub repository id must be numeric.");
  return value;
}
async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = "", bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("Hosted repository API response exceeds its safety bound."); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
function validateState(value: unknown): RegistryState {
  if (!value || typeof value !== "object" || (value as any).schemaVersion !== 1 || !Array.isArray((value as any).providers) || !Array.isArray((value as any).links)) {
    throw new Error("Hosted repository registry is malformed.");
  }
  const state = value as RegistryState;
  state.operations = Array.isArray((value as any).operations) ? (value as any).operations : [];
  for (const operation of state.operations) if (operation.status === "pending") {
    operation.status = "uncertain";
    operation.errorCode = "restart_during_operation";
    operation.updatedAt = new Date().toISOString();
  }
  return state;
}
async function defaultLocalHead(workspacePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"], { timeout: 30_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH ?? "" } }, (error, stdout) => {
      if (error) return reject(new Error("Local repository HEAD could not be read."));
      const head = stdout.trim();
      if (!/^[a-f0-9]{40,64}$/i.test(head)) return reject(new Error("Local repository HEAD is invalid."));
      resolve(head);
    });
  });
}

function boundedInput(value: string, max: number, label: string): string {
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error(`Hosted ${label} is invalid.`);
  return text;
}
function safeHostedFilePath(value: string): string {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.length > 500 || path.startsWith("/") || path.endsWith("/") || path.includes("//") || path.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.length > 200) || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Hosted repository file path is invalid.");
  }
  return path;
}
function safeHostedRef(value: string): string {
  const ref = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) || ref.includes("..") || ref.includes("//") || ref.includes("@{") || ref.endsWith("/") || ref.endsWith(".")) {
    throw new Error("Hosted repository file ref is invalid.");
  }
  return ref;
}
function safeBranch(value: string): string {
  const branch = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.includes("@{") || branch.endsWith("/") || branch.endsWith(".")) throw new Error("Hosted review branch is invalid.");
  return branch;
}
function positiveNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000_000) throw new Error("Hosted review number is invalid.");
  return value;
}
function githubRepoPath(fullName: string, suffix: string): string {
  const [owner, repository, ...extra] = fullName.split("/");
  if (!owner || !repository || extra.length) throw new Error("GitHub repository full name is invalid.");
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${suffix}`;
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
