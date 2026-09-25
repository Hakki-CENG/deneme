import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostedRepositoryProviderRegistry } from "../src/repositories/hosted-repository-provider.js";
import { CredentialBroker } from "../src/security/credential-broker.js";

const importedHead = "a".repeat(40), localHead = "b".repeat(40);
const githubRepo = {
  id: 101, full_name: "org/repo", private: true, default_branch: "main",
  clone_url: "https://github.com/org/repo.git", html_url: "https://github.com/org/repo", updated_at: "2026-08-18T00:00:00Z",
};

describe("hosted GitHub/GitLab repository providers", () => {
  it("lists GitHub account repositories/reviews and links imported sessions without token disclosure", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-hosted-github-"));
    const credentials = new CredentialBroker(root, "stable-key");
    const secret = await credentials.put({ tenantId: "tenant", name: "GITHUB_ACCOUNT_TOKEN", value: "github-super-secret" });
    const calls: Array<{ url: string; headers: Headers }> = [];
    const registry = new HostedRepositoryProviderRegistry({
      rootPath: root, credentials, urlGuard: async (value) => new URL(value), localHead: async () => localHead,
      fetch: async (input, init) => {
        const url = String(input); calls.push({ url, headers: new Headers(init?.headers) });
        if (url.includes("/user/repos?")) return Response.json([githubRepo]);
        if (url.endsWith("/repositories/101")) return Response.json(githubRepo);
        if (url.includes("/repos/org/repo/contents/.haf/automations.json?ref=main")) return Response.json({
          type: "file", encoding: "base64", content: Buffer.from('{"schemaVersion":1,"automations":[]}').toString("base64"),
          size: Buffer.byteLength('{"schemaVersion":1,"automations":[]}'), sha: "c".repeat(40),
        });
        if (url.includes("/repos/org/repo/pulls?")) return Response.json([{
          id: 900, number: 7, title: "Improve runtime", state: "open", draft: false,
          head: { ref: "feature" }, base: { ref: "main" }, html_url: "https://github.com/org/repo/pull/7",
          user: { login: "alice" }, updated_at: "2026-08-18T01:00:00Z",
        }]);
        if (url.endsWith("/repos/org/repo/branches/main")) return Response.json({ commit: { sha: importedHead } });
        return Response.json({ error: "missing" }, { status: 404 });
      },
    });
    const provider = await registry.add({ tenantId: "tenant", name: "GitHub", kind: "github", credentialSecretId: secret.id });
    expect(provider).toMatchObject({ kind: "github", credentialConfigured: true, githubAccountMode: "user" });
    const repositories = await registry.repositories(provider.id, "tenant");
    expect(repositories).toEqual([expect.objectContaining({ repositoryId: "101", fullName: "org/repo", private: true })]);
    const reviews = await registry.reviews(provider.id, "tenant", "101");
    expect(reviews).toEqual([expect.objectContaining({ number: 7, sourceBranch: "feature", targetBranch: "main", author: "alice" })]);
    const manifest = await registry.readFile(provider.id, "tenant", "101", ".haf/automations.json", "main");
    expect(manifest).toMatchObject({ path: ".haf/automations.json", ref: "main", remoteVersion: "c".repeat(40), content: '{"schemaVersion":1,"automations":[]}' });
    expect(manifest.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    const selected = await registry.resolveImport(provider.id, "tenant", "101");
    expect(selected).toMatchObject({ credentialSecretId: secret.id, credentialUsername: "x-access-token", repository: { cloneUrl: "https://github.com/org/repo.git" } });
    await registry.linkSession({ sessionId: "session", tenantId: "tenant", providerId: provider.id, repository: selected.repository, importedHead });
    expect(await registry.syncStatus("session", "tenant", "/workspace")).toMatchObject({ linked: true, localHead, remoteHead: importedHead, state: "local_changed" });
    expect(calls.every((call) => call.headers.get("authorization") === "Bearer github-super-secret")).toBe(true);
    expect(calls.every((call) => call.headers.get("x-github-api-version") === "2022-11-28")).toBe(true);
    expect(JSON.stringify(await registry.list("tenant"))).not.toContain("github-super-secret");
    expect(await readFile(join(root, "repositories", "hosted-providers.json"), "utf8")).not.toContain("github-super-secret");
  });

  it("supports GitLab private-token account metadata and merge requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-hosted-gitlab-"));
    const credentials = new CredentialBroker(root, "stable-key");
    const secret = await credentials.put({ tenantId: "tenant", name: "GITLAB_ACCOUNT_TOKEN", value: "gitlab-super-secret" });
    const headers: Headers[] = [];
    const project = {
      id: 202, path_with_namespace: "group/project", visibility: "private", default_branch: "main",
      http_url_to_repo: "https://gitlab.com/group/project.git", web_url: "https://gitlab.com/group/project",
    };
    const registry = new HostedRepositoryProviderRegistry({
      rootPath: root, credentials, urlGuard: async (value) => new URL(value),
      fetch: async (input, init) => {
        const url = String(input); headers.push(new Headers(init?.headers));
        if (url.includes("/projects?")) return Response.json([project]);
        if (url.endsWith("/projects/202")) return Response.json(project);
        if (url.includes("/projects/202/merge_requests?")) return Response.json([{
          id: 1, iid: 3, title: "Merge feature", state: "opened", source_branch: "feature", target_branch: "main",
          web_url: "https://gitlab.com/group/project/-/merge_requests/3", author: { username: "bob" },
        }]);
        return Response.json({ message: "missing" }, { status: 404 });
      },
    });
    const provider = await registry.add({
      tenantId: "tenant", name: "GitLab", kind: "gitlab", credentialSecretId: secret.id, authStyle: "private-token",
    });
    expect(await registry.repositories(provider.id, "tenant")).toContainEqual(expect.objectContaining({ repositoryId: "202", fullName: "group/project" }));
    expect(await registry.reviews(provider.id, "tenant", "202")).toContainEqual(expect.objectContaining({ number: 3, author: "bob" }));
    expect(headers.every((item) => item.get("private-token") === "gitlab-super-secret" && !item.has("authorization"))).toBe(true);
  });

  it("fails closed on unsafe origins, redirects, disabled providers and clone-origin substitution", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-hosted-guards-"));
    const credentials = new CredentialBroker(root, "key");
    const secret = await credentials.put({ tenantId: "tenant", name: "HOSTED_TOKEN", value: "secret" });
    const strict = new HostedRepositoryProviderRegistry({ rootPath: root, credentials });
    await expect(strict.add({ tenantId: "tenant", name: "unsafe", kind: "gitlab", credentialSecretId: secret.id, apiBase: "https://127.0.0.1/api/v4" })).rejects.toThrow("Private or special-use");

    const redirecting = new HostedRepositoryProviderRegistry({
      rootPath: join(root, "redirect"), credentials, urlGuard: async (value) => new URL(value),
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    });
    const provider = await redirecting.add({ tenantId: "tenant", name: "redirect", kind: "github", credentialSecretId: secret.id });
    await expect(redirecting.repositories(provider.id, "tenant")).rejects.toThrow("redirects are forbidden");
    await redirecting.setEnabled(provider.id, "tenant", false);
    await expect(redirecting.repositories(provider.id, "tenant")).rejects.toThrow("disabled");

    const substituted = new HostedRepositoryProviderRegistry({
      rootPath: join(root, "substitute"), credentials, urlGuard: async (value) => new URL(value),
      fetch: async (input) => String(input).endsWith("/repositories/99")
        ? Response.json({ ...githubRepo, id: 99, clone_url: "https://evil.example/repo.git" })
        : Response.json([]),
    });
    const bound = await substituted.add({ tenantId: "tenant", name: "bound", kind: "github", credentialSecretId: secret.id });
    await expect(substituted.resolveImport(bound.id, "tenant", "99")).rejects.toThrow("escaped its configured origin");
  });
});
