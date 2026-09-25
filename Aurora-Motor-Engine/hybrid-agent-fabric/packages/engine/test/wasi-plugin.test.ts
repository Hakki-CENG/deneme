import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import wabtFactory from "wabt";
import { describe, expect, it } from "vitest";
import { CapabilityBroker } from "../src/capabilities/capability-broker.js";
import { EffectJournal } from "../src/persistence/effect-journal.js";
import { ApprovalService } from "../src/policy/approval-service.js";
import { DefaultPolicyEngine } from "../src/policy/policy-engine.js";
import { HookBus } from "../src/plugins/hook-bus.js";
import { WasiPluginManager, type WasiPluginManifest } from "../src/plugins/wasi/wasi-plugin-manager.js";

async function wasmReturning(json: string): Promise<Buffer> {
  const wabt = await wabtFactory();
  const escaped = [...Buffer.from(json)].map((byte) => `\\${byte.toString(16).padStart(2, "0")}`).join("");
  const length = Buffer.byteLength(json);
  const wat = `(module
    (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
    (memory (export "memory") 1)
    (data (i32.const 16) "${escaped}")
    (func (export "_start")
      (i32.store (i32.const 0) (i32.const 16))
      (i32.store (i32.const 4) (i32.const ${length}))
      (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))
    ))`;
  const module = wabt.parseWat("plugin.wat", wat);
  const binary = module.toBinary({ write_debug_names: true });
  module.destroy();
  return Buffer.from(binary.buffer);
}

async function signedPlugin(root: string, tamperSignature = false) {
  const source = join(root, "source"); await mkdir(source, { recursive: true });
  const wasm = await wasmReturning('{"result":{"ok":true}}');
  await writeFile(join(source, "plugin.wasm"), wasm);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest: WasiPluginManifest = {
    schemaVersion: 1, id: "signed.test", version: "1.0.0", apiVersion: "haf.plugin.v1",
    module: "plugin.wasm", sha256: createHash("sha256").update(wasm).digest("hex"),
    keyId: "test-key", signature: "",
    capabilities: [{
      id: "check", action: "check", description: "Signed WASI check", risk: "pure", sideEffect: false,
      inputSchema: { type: "object", additionalProperties: false },
    }], hooks: [],
  };
  manifest.signature = sign(null, WasiPluginManager.canonicalManifestPayload(manifest), privateKey).toString("base64");
  if (tamperSignature) manifest.signature = Buffer.alloc(64).toString("base64");
  await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
  return { source, publicKey: publicKey.export({ format: "pem", type: "spki" }).toString() };
}

/**
 * The runner is a build artefact, not source. When it is missing the manager
 * reports `exit 1; stderr class=present`, which hides the cause and reads like
 * a plugin-sandbox failure. Name the real problem instead.
 */
const RUNNER_PATH = resolve(process.cwd(), "../../apps/wasi-runner/dist/main.js");

describe("signed out-of-process WASI plugins", () => {
  it("verifies, registers, executes and removes a capability", async () => {
    if (!existsSync(RUNNER_PATH)) {
      throw new Error(
        `The WASI runner is not built at ${RUNNER_PATH}. Run \`npm run build -w @haf/wasi-runner\` ` +
          "(the root `pretest` script does this; a bare `npx vitest run` does not). " +
          "This is a missing build artefact, not a plugin-sandbox failure.",
      );
    }
    const root = await mkdtemp(join(tmpdir(), "haf-wasi-"));
    const plugin = await signedPlugin(root);
    const broker = new CapabilityBroker(new DefaultPolicyEngine(), new ApprovalService(), new EffectJournal(root));
    const hooks = new HookBus();
    const manager = new WasiPluginManager(broker, hooks, {
      rootPath: root,
      runnerPath: RUNNER_PATH,
      trustedPublicKeys: { "test-key": plugin.publicKey },
    });
    const installed = await manager.install(plugin.source);
    expect(installed.capabilities).toEqual(["plugin.signed.test.check"]);
    const result = await broker.execute("plugin.signed.test.check", {}, {
      tenantId: "tenant", sessionId: "session", familyId: "family", turnId: "turn", toolCallId: "tool",
      source: "api", workspacePath: root, idempotencyKey: "id",
    });
    expect(result).toEqual({ ok: true });
    await manager.uninstall("signed.test");
    expect(broker.list().some((item) => item.id === "plugin.signed.test.check")).toBe(false);
  }, 20_000);

  it("rejects untrusted signatures before process execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-wasi-"));
    const plugin = await signedPlugin(root, true);
    const broker = new CapabilityBroker(new DefaultPolicyEngine(), new ApprovalService(), new EffectJournal(root));
    const manager = new WasiPluginManager(broker, new HookBus(), {
      rootPath: root,
      runnerPath: "/must/not/run",
      trustedPublicKeys: { "test-key": plugin.publicKey },
    });
    await expect(manager.install(plugin.source)).rejects.toThrow("signature is invalid");
  });
});
