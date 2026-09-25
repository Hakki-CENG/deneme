import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GitHubAppManager,
  GitHubAppPendingNotFoundError,
  GitHubAppWebhookVerificationError,
  createAppJwt,
} from "../src/repositories/github-app-manager.js";
import { HostedRepositoryProviderRegistry } from "../src/repositories/hosted-repository-provider.js";
import { CredentialBroker } from "../src/security/credential-broker.js";

function rsaPem() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: pair.publicKey,
  };
}

function verifiesJwt(token: string, publicKey: ReturnType<typeof rsaPem>["publicKey"]): boolean {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return false;
  return verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"));
}

function jwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
}

describe("GitHub App installation lifecycle", () => {
  it("persists state-only installation coordination, verifies the installation, rotates keys and supplies hosted repository credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-github-app-"));
    const credentials = new CredentialBroker(root, "stable-master-key");
    const first = rsaPem(), second = rsaPem();
    const firstSecret = await credentials.put({ tenantId: "tenant", name: "GITHUB_APP_PRIVATE_KEY_A", value: first.privatePem });
    const secondSecret = await credentials.put({ tenantId: "tenant", name: "GITHUB_APP_PRIVATE_KEY_B", value: second.privatePem });
    const webhookSecret = await credentials.put({ tenantId: "tenant", name: "GITHUB_APP_WEBHOOK_SECRET", value: "webhook-super-secret" });
    let now = Date.parse("2026-08-19T12:00:00Z"), tokenMints = 0;
    const apiCalls: Array<{ url: string; authorization: string; apiVersion: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input), headers = new Headers(init?.headers);
      const authorization = headers.get("authorization") ?? "";
      apiCalls.push({ url, authorization, apiVersion: headers.get("x-github-api-version") });
      if (url === "https://api.github.test/app/installations/987654" && init?.method === "GET") {
        const jwt = authorization.replace(/^Bearer /, "");
        expect(verifiesJwt(jwt, first.publicKey) || verifiesJwt(jwt, second.publicKey)).toBe(true);
        const payload = jwtPayload(jwt);
        expect(payload.iss).toBe("Iv1.client123");
        expect(Number(payload.iat)).toBe(Math.floor(now / 1000) - 60);
        expect(Number(payload.exp)).toBeLessThanOrEqual(Math.floor(now / 1000) + 600);
        return Response.json({
          id: 987654, app_id: 424242, repository_selection: "selected",
          account: { id: 777, login: "example-org", type: "Organization" },
        });
      }
      if (url === "https://api.github.test/app/installations/987654/access_tokens" && init?.method === "POST") {
        const jwt = authorization.replace(/^Bearer /, "");
        if (verifiesJwt(jwt, first.publicKey)) return Response.json({ message: "old key rejected" }, { status: 401 });
        expect(verifiesJwt(jwt, second.publicKey)).toBe(true);
        tokenMints++;
        return Response.json({ token: `ghs_stateless_${tokenMints}_secret`, expires_at: new Date(now + 60 * 60_000).toISOString() });
      }
      if (url.includes("/installation/repositories?")) {
        expect(authorization).toBe(`Bearer ghs_stateless_${tokenMints}_secret`);
        return Response.json({ repositories: [{
          id: 101, full_name: "example-org/repo", private: true, default_branch: "main",
          clone_url: "https://github.com/example-org/repo.git", html_url: "https://github.com/example-org/repo",
        }] });
      }
      if (url.endsWith("/repositories/101")) {
        expect(authorization).toBe(`Bearer ghs_stateless_${tokenMints}_secret`);
        return Response.json({
          id: 101, full_name: "example-org/repo", private: true, default_branch: "main",
          clone_url: "https://github.com/example-org/repo.git", html_url: "https://github.com/example-org/repo",
        });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    };
    const options = {
      rootPath: root, credentials, fetch: fetchImpl,
      urlGuard: async (value: string) => new URL(value), now: () => now,
    };
    const manager = new GitHubAppManager(options);
    const app = await manager.register({
      tenantId: "tenant", name: "HAF GitHub App", appId: "424242", clientId: "Iv1.client123",
      appSlug: "haf-example", privateKeySecretIds: [firstSecret.id, secondSecret.id],
      webhookSecretIds: [webhookSecret.id], apiBase: "https://api.github.test", webBase: "https://github.test",
    });
    expect(app.privateKeys).toHaveLength(2);
    expect(app.privateKeys.every((key) => !(key as any).secretId)).toBe(true);
    expect(app.webhookSecrets.every((key) => !(key as any).secretId)).toBe(true);

    const start = await manager.startInstallation({ appConfigId: app.id, tenantId: "tenant", returnTo: "/canvas/?panel=repositories" });
    const installationUrl = new URL(start.installationUrl);
    expect(installationUrl.origin).toBe("https://github.test");
    expect(installationUrl.pathname).toBe("/apps/haf-example/installations/new");
    const state = installationUrl.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(32);

    // Pending state is restart-resumable and only its digest is persisted.
    const restarted = new GitHubAppManager(options);
    const duplicateCallbacks = await Promise.allSettled([
      restarted.finishInstallation({ state, installationId: "987654", setupAction: "install" }),
      restarted.finishInstallation({ state, installationId: "987654", setupAction: "install" }),
    ]);
    expect(duplicateCallbacks.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(duplicateCallbacks.filter((item) => item.status === "rejected")).toHaveLength(1);
    const finished = (duplicateCallbacks.find((item) => item.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<GitHubAppManager["finishInstallation"]>>>).value;
    expect(finished.returnTo).toBe("/canvas/?panel=repositories");
    expect(finished.installation).toMatchObject({
      accountLogin: "example-org", accountType: "Organization", repositorySelection: "selected", status: "active",
    });
    expect(finished.installation.installationProjection).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(finished.installation)).not.toContain("987654");
    await expect(restarted.finishInstallation({ state, installationId: "987654", setupAction: "install" })).rejects.toBeInstanceOf(GitHubAppPendingNotFoundError);
    const spoofStart = await restarted.startInstallation({ appConfigId: app.id, tenantId: "tenant" });
    const spoofState = new URL(spoofStart.installationUrl).searchParams.get("state")!;
    await expect(restarted.finishInstallation({ state: spoofState, installationId: "111111", setupAction: "install" })).rejects.toThrow("HTTP 404");

    const hosted = new HostedRepositoryProviderRegistry({
      rootPath: root, credentials, githubApps: restarted, fetch: fetchImpl,
      urlGuard: async (value) => new URL(value),
    });
    const provider = await hosted.add({
      tenantId: "tenant", name: "GitHub App account", kind: "github",
      githubAppInstallationId: finished.installation.id,
    });
    expect(provider).toMatchObject({ authSource: "github_app", githubAccountMode: "installation", credentialConfigured: true });
    expect(provider.credentialSecretId).toBeUndefined();
    expect(await hosted.repositories(provider.id, "tenant")).toContainEqual(expect.objectContaining({ fullName: "example-org/repo" }));
    expect(tokenMints).toBe(1);
    const selected = await hosted.resolveImport(provider.id, "tenant", "101");
    expect(selected.credentialSecretId).toMatch(/^[a-f0-9-]{36}$/);
    expect(selected.credentialUsername).toBe("x-access-token");
    expect(tokenMints).toBe(1);

    // Refresh before expiry; the first private key is rejected and the second succeeds.
    now += 56 * 60_000;
    expect(await restarted.accessToken(finished.installation.id, "tenant")).toBe("ghs_stateless_2_secret");
    expect(tokenMints).toBe(2);
    const disabled = await restarted.setPrivateKeyEnabled({
      appConfigId: app.id, tenantId: "tenant", keyId: app.privateKeys[0]!.id, enabled: false,
    });
    expect(disabled.privateKeys.find((key) => key.id === app.privateKeys[0]!.id)?.enabled).toBe(false);
    await expect(restarted.setPrivateKeyEnabled({
      appConfigId: app.id, tenantId: "tenant", keyId: app.privateKeys[1]!.id, enabled: false,
    })).rejects.toThrow("last active");

    expect(apiCalls.every((call) => call.apiVersion === "2026-03-10" || call.url.startsWith("https://api.github.com/"))).toBe(true);
    const disk = await readFile(join(root, "github-apps", "state.json"), "utf8");
    for (const forbidden of [state, spoofState, "987654", "111111", "ghs_stateless_", "PRIVATE KEY", "webhook-super-secret"]) expect(disk).not.toContain(forbidden);
    expect(JSON.stringify(await restarted.list("tenant"))).not.toContain("PRIVATE KEY");
  });

  it("validates and deduplicates signed lifecycle/repository/review webhooks without persisting raw installation IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-github-webhook-"));
    const credentials = new CredentialBroker(root, "stable-master-key");
    const key = rsaPem();
    const keySecret = await credentials.put({ tenantId: "tenant", name: "GITHUB_APP_KEY", value: key.privatePem });
    const oldWebhook = await credentials.put({ tenantId: "tenant", name: "GITHUB_WEBHOOK_OLD", value: "old-webhook-secret" });
    const newWebhook = await credentials.put({ tenantId: "tenant", name: "GITHUB_WEBHOOK_NEW", value: "new-webhook-secret" });
    const manager = new GitHubAppManager({
      rootPath: root, credentials, urlGuard: async (value) => new URL(value),
      fetch: async () => Response.json({}),
    });
    const app = await manager.register({
      tenantId: "tenant", name: "Webhook app", appId: "515151", appSlug: "webhook-app",
      privateKeySecretIds: [keySecret.id], webhookSecretIds: [oldWebhook.id],
    });
    const rotated = await manager.rotateWebhookSecret({ appConfigId: app.id, tenantId: "tenant", secretId: newWebhook.id });
    expect(rotated.webhookSecrets.filter((item) => item.enabled)).toHaveLength(2);

    const payload = {
      action: "created",
      app: { id: 515151 },
      installation: {
        id: 222222, app_id: 515151, repository_selection: "all",
        account: { id: 333, login: "octo-org", type: "Organization" },
      },
      repository: { id: 444 },
      pull_request: { number: 9, head: { sha: "a".repeat(40) } },
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", "new-webhook-secret").update(raw).digest("hex")}`;
    const input = {
      rawBody: raw, signature, deliveryId: "delivery-0001", event: "pull_request", payload,
    };
    const accepted = await manager.ingestWebhook(input);
    expect(accepted).toMatchObject({ accepted: true, duplicate: false, event: "pull_request" });
    expect((await manager.ingestWebhook(input)).duplicate).toBe(true);
    const installations = await manager.installations("tenant", app.id);
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({ status: "active", accountLogin: "octo-org" });
    expect(JSON.stringify(installations)).not.toContain("222222");
    expect(await manager.webhookEvents("tenant", app.id)).toContainEqual(expect.objectContaining({
      event: "pull_request", action: "created", repositoryId: "444", reviewNumber: 9, headSha: "a".repeat(40),
    }));

    await expect(manager.ingestWebhook({ ...input, deliveryId: "delivery-0002", signature: "sha256=" + "0".repeat(64) }))
      .rejects.toBeInstanceOf(GitHubAppWebhookVerificationError);

    const deletedPayload = { action: "deleted", app: { id: 515151 }, installation: payload.installation };
    const deletedRaw = Buffer.from(JSON.stringify(deletedPayload));
    const deletedSignature = `sha256=${createHmac("sha256", "old-webhook-secret").update(deletedRaw).digest("hex")}`;
    await manager.ingestWebhook({
      rawBody: deletedRaw, signature: deletedSignature, deliveryId: "delivery-0003", event: "installation", payload: deletedPayload,
    });
    expect((await manager.installations("tenant", app.id))[0]!.status).toBe("deleted");

    const disk = await readFile(join(root, "github-apps", "state.json"), "utf8");
    for (const forbidden of ["222222", "old-webhook-secret", "new-webhook-secret", "PRIVATE KEY"]) expect(disk).not.toContain(forbidden);
  });

  it("emits standards-conforming RS256 JWTs", () => {
    const key = rsaPem();
    const now = Date.parse("2026-08-19T00:00:00Z");
    const token = createAppJwt("Iv1.example", key.privatePem, now);
    expect(verifiesJwt(token, key.publicKey)).toBe(true);
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(jwtPayload(token)).toEqual({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: "Iv1.example" });
  });
});
