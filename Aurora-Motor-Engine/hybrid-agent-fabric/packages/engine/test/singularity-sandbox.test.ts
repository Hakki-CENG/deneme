import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SingularitySandbox, createSandboxFactory } from "../src/sandbox/sandbox.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Singularity/Apptainer sandbox", () => {
  it("requires supply-chain pinning unless explicitly overridden", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "haf-singularity-validation-"));
    expect(() => new SingularitySandbox(workspace, { image: "docker://alpine:latest" })).toThrow("must be pinned");
    expect(() => new SingularitySandbox(workspace, { image: "/tmp/agent.sif" })).toThrow("require imageSha256");
    expect(() => new SingularitySandbox(workspace, {
      image: "docker://alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      executable: "bad executable",
    })).toThrow("executable is invalid");
  });

  it("verifies a local SIF and assembles a contained, network-disabled invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-singularity-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const image = join(root, "agent.sif");
    const imageBody = "fake-sif-for-adapter-contract";
    await writeFile(image, imageBody);
    const executable = join(root, "fake-apptainer");
    await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' \"$*\"\n");
    await chmod(executable, 0o700);
    const sandbox = await createSandboxFactory("singularity", {
      singularity: { image, imageSha256: sha256(imageBody), executable, network: "none" },
    })(workspace);
    const result = await sandbox.exec({ command: "printf hello", env: { SAFE_VALUE: "yes", "BAD-NAME": "ignored" } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--cleanenv");
    expect(result.stdout).toContain("--containall");
    expect(result.stdout).toContain("--network none");
    expect(result.stdout).toContain("SAFE_VALUE=yes");
    expect(result.stdout).not.toContain("BAD-NAME");

    await writeFile(image, "tampered");
    await expect(sandbox.exec({ command: "true" })).rejects.toThrow("SHA-256 verification failed");
  });
});
