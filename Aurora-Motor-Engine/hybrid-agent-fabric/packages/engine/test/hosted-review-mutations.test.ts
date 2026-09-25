import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostedRepositoryProviderRegistry } from "../src/repositories/hosted-repository-provider.js";
import { CredentialBroker } from "../src/security/credential-broker.js";

const sha = "a".repeat(40);
const githubRepo = { id: 101, full_name: "org/repo", private: true, default_branch: "main", clone_url: "https://github.com/org/repo.git", html_url: "https://github.com/org/repo" };

describe("hosted pull/merge request mutations", () => {
  it("creates, comments, closes and exact-SHA merges GitHub reviews with local idempotency", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-review-github-"));
    const credentials = new CredentialBroker(root, "key");
    const secret = await credentials.put({ tenantId: "tenant", name: "GITHUB_WRITE_TOKEN", value: "github-write-secret" });
    const calls: Array<{ url: string; method: string; body: any; auth: string }> = [];
    const registry = new HostedRepositoryProviderRegistry({
      rootPath: root, credentials, urlGuard: async value => new URL(value),
      fetch: async (input, init) => {
        const url = String(input), method = String(init?.method ?? "GET"), body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body, auth: new Headers(init?.headers).get("authorization") ?? "" });
        if (method === "GET" && url.endsWith("/repositories/101")) return Response.json(githubRepo);
        if (method === "POST" && url.endsWith("/repos/org/repo/pulls")) return Response.json({ id: 900, number: 7 });
        if (method === "POST" && url.endsWith("/issues/7/comments")) return Response.json({ id: 901 });
        if (method === "PATCH" && url.endsWith("/pulls/7")) return Response.json({ id: 900, state: "closed" });
        if (method === "PUT" && url.endsWith("/pulls/7/merge")) return Response.json({ merged: true, sha });
        return Response.json({ message: "missing" }, { status: 404 });
      },
    });
    const provider = await registry.add({ tenantId: "tenant", name: "GitHub write", kind: "github", credentialSecretId: secret.id });
    const created = await registry.createReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "101", title: "Add feature", body: "private review body", sourceBranch: "feature", targetBranch: "main", idempotencyKey: "review-create-1" });
    expect(created).toMatchObject({ kind: "create", status: "succeeded", reviewNumber: 7, remoteId: "900" });
    expect(await registry.createReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "101", title: "different", sourceBranch: "other", targetBranch: "main", idempotencyKey: "review-create-1" })).toEqual(created);
    expect(calls.filter(call => call.method === "POST" && call.url.endsWith("/pulls")).length).toBe(1);
    expect(await registry.commentReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "101", reviewNumber: 7, body: "private comment", idempotencyKey: "review-comment-1" })).toMatchObject({ status: "succeeded", remoteId: "901" });
    expect(await registry.closeReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "101", reviewNumber: 7, idempotencyKey: "review-close-01" })).toMatchObject({ status: "succeeded" });
    expect(await registry.mergeReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "101", reviewNumber: 7, expectedHeadSha: sha, method: "squash", idempotencyKey: "review-merge-01" })).toMatchObject({ status: "succeeded", remoteId: sha });
    expect(calls.find(call => call.url.endsWith("/pulls"))?.body).toMatchObject({ title: "Add feature", head: "feature", base: "main", draft: false });
    expect(calls.find(call => call.url.endsWith("/pulls/7/merge"))?.body).toEqual({ sha, merge_method: "squash" });
    expect(calls.every(call => call.auth === "Bearer github-write-secret")).toBe(true);
    const state = await readFile(join(root, "repositories", "hosted-providers.json"), "utf8");
    expect(state).not.toContain("github-write-secret");
    expect(state).not.toContain("private review body");
    expect(state).not.toContain("private comment");
    expect(state).not.toContain("review-create-1");
    expect(await registry.listOperations("tenant", provider.id)).toHaveLength(4);
  });

  it("maps GitLab merge request write contracts without leaking private tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-review-gitlab-"));
    const credentials = new CredentialBroker(root, "key");
    const secret = await credentials.put({ tenantId: "tenant", name: "GITLAB_WRITE_TOKEN", value: "gitlab-write-secret" });
    const project = { id: 202, path_with_namespace: "group/project", visibility: "private", default_branch: "main", http_url_to_repo: "https://gitlab.com/group/project.git", web_url: "https://gitlab.com/group/project" };
    const calls: Array<{ url: string; method: string; body: any; token: string }> = [];
    const registry = new HostedRepositoryProviderRegistry({
      rootPath: root, credentials, urlGuard: async value => new URL(value),
      fetch: async (input, init) => {
        const url = String(input), method = String(init?.method ?? "GET"), body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body, token: new Headers(init?.headers).get("private-token") ?? "" });
        if (method === "GET") return Response.json(project);
        if (url.endsWith("/merge_requests") && method === "POST") return Response.json({ id: 300, iid: 3 });
        if (url.endsWith("/merge_requests/3/notes")) return Response.json({ id: 301 });
        if (url.endsWith("/merge_requests/3/merge")) return Response.json({ id: 300, sha });
        if (url.endsWith("/merge_requests/3")) return Response.json({ id: 300, state: "closed" });
        return Response.json({}, { status: 404 });
      },
    });
    const provider = await registry.add({ tenantId: "tenant", name: "GitLab write", kind: "gitlab", credentialSecretId: secret.id, authStyle: "private-token" });
    await registry.createReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "202", title: "Feature", sourceBranch: "feature", targetBranch: "main", draft: true, idempotencyKey: "gitlab-create-1" });
    await registry.commentReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "202", reviewNumber: 3, body: "comment", idempotencyKey: "gitlab-comment-1" });
    await registry.closeReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "202", reviewNumber: 3, idempotencyKey: "gitlab-close-001" });
    await registry.mergeReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "202", reviewNumber: 3, expectedHeadSha: sha, method: "merge", idempotencyKey: "gitlab-merge-001" });
    expect(calls.find(call => call.url.endsWith("/merge_requests") && call.method === "POST")?.body).toMatchObject({ title: "Draft: Feature", source_branch: "feature", target_branch: "main", remove_source_branch: false });
    expect(calls.find(call => call.url.endsWith("/merge_requests/3/merge"))?.body).toMatchObject({ sha, merge_when_pipeline_succeeds: false, should_remove_source_branch: false });
    expect(calls.every(call => call.token === "gitlab-write-secret")).toBe(true);
  });

  it("records ambiguous transport outcomes as uncertain and deterministic 4xx as failed without replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-review-uncertain-"));
    const credentials = new CredentialBroker(root, "key");
    const secret = await credentials.put({ tenantId: "tenant", name: "REVIEW_TOKEN", value: "secret" });
    let mutationCalls = 0;
    const registry = new HostedRepositoryProviderRegistry({
      rootPath: root, credentials, urlGuard: async value => new URL(value),
      fetch: async (input, init) => {
        if ((init?.method ?? "GET") === "GET") return Response.json(githubRepo);
        mutationCalls++;
        if (String(input).includes("issues/8")) return Response.json({ message: "invalid" }, { status: 422 });
        throw new TypeError("connection reset after send");
      },
    });
    const provider = await registry.add({ tenantId: "tenant", name: "GitHub", kind: "github", credentialSecretId: secret.id });
    await expect(registry.createReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "101", title: "Maybe created", sourceBranch: "feature", targetBranch: "main", idempotencyKey: "uncertain-create" })).rejects.toThrow("connection reset");
    const uncertain = (await registry.listOperations("tenant"))[0]!;
    expect(uncertain).toMatchObject({ status: "uncertain", errorCode: "transport_or_response_error" });
    expect(await registry.createReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "101", title: "retry", sourceBranch: "feature", targetBranch: "main", idempotencyKey: "uncertain-create" })).toEqual(uncertain);
    expect(mutationCalls).toBe(1);
    await expect(registry.commentReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "101", reviewNumber: 8, body: "bad", idempotencyKey: "failed-comment-1" })).rejects.toThrow("HTTP 422");
    expect((await registry.listOperations("tenant")).find(item => item.kind === "comment")).toMatchObject({ status: "failed", errorCode: "http_422" });
    await expect(registry.mergeReview({ providerId: provider.id, tenantId: "tenant", repositoryId: "101", reviewNumber: 1, expectedHeadSha: "bad", idempotencyKey: "merge-invalid-1" })).rejects.toThrow("HEAD SHA");
  });
});
