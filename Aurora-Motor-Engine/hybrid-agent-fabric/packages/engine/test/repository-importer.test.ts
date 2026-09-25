import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RepositoryImporter, type RepositoryImportRunnerInput } from "../src/repositories/repository-importer.js";
import { CredentialBroker } from "../src/security/credential-broker.js";

const head = "a".repeat(40);

describe("secure remote repository import", () => {
  it("redeems scoped credentials through askpass without URL/argument disclosure", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-repository-import-"));
    const broker = new CredentialBroker(root, "master-key");
    const secret = await broker.put({ tenantId: "tenant", name: "GITHUB_TOKEN", value: "repository-secret-token" });
    const calls: RepositoryImportRunnerInput[] = [];
    const importer = new RepositoryImporter({
      workspaceRoot: join(root, "workspaces"), stateRoot: join(root, "state"), credentials: broker,
      urlGuard: async (url) => new URL(url),
      runner: async (input) => {
        calls.push(input);
        if (input.args.includes("clone")) {
          const destination = input.args.at(-1)!;
          expect(input.env.HAF_GIT_PASSWORD).toBe("repository-secret-token");
          await mkdir(join(destination, ".git"), { recursive: true });
          await writeFile(join(destination, "README.md"), "hello");
          return { exitCode: 0, output: "cloned" };
        }
        return { exitCode: 0, output: head };
      },
    });
    const result = await importer.import({
      tenantId: "tenant", url: "https://github.example.test/org/repo.git", branch: "main",
      credentialSecretId: secret.id, credentialUsername: "oauth2",
    });
    expect(result).toEqual(expect.objectContaining({ origin: "https://github.example.test", head, files: 1, bytes: 5 }));
    const clone = calls[0]!;
    expect(clone.args).toContain("http.followRedirects=false");
    expect(clone.args).toContain("--filter=blob:none");
    expect(JSON.stringify(clone.args)).not.toContain("repository-secret-token");
    expect(JSON.stringify(result)).not.toContain("repository-secret-token");
    await expect(access(String(clone.env.GIT_ASKPASS))).rejects.toThrow();
  });

  it("rejects unsafe URLs/branches and cleans up imports exceeding limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-repository-limits-"));
    const broker = new CredentialBroker(root, "key");
    const guarded = new RepositoryImporter({ workspaceRoot: join(root, "w1"), stateRoot: join(root, "s1"), credentials: broker });
    await expect(guarded.import({ tenantId: "tenant", url: "https://127.0.0.1/repo.git" })).rejects.toThrow("Private or special-use");
    const importer = new RepositoryImporter({
      workspaceRoot: join(root, "w2"), stateRoot: join(root, "s2"), credentials: broker,
      maxFiles: 1, urlGuard: async (url) => new URL(url),
      runner: async (input) => {
        if (input.args.includes("clone")) {
          const destination = input.args.at(-1)!;
          await mkdir(join(destination, ".git"), { recursive: true });
          await writeFile(join(destination, "a"), "a");
          await writeFile(join(destination, "b"), "b");
        }
        return { exitCode: 0, output: head };
      },
    });
    await expect(importer.import({ tenantId: "tenant", url: "https://example.test/repo.git" })).rejects.toThrow("exceeds");
    await expect(importer.import({ tenantId: "tenant", url: "https://example.test/repo.git", branch: "../bad" })).rejects.toThrow("branch name");
  });
});
