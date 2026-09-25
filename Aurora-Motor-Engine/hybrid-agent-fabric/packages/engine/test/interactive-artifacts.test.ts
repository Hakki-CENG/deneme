import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InteractiveArtifactRegistry } from "../src/artifacts/interactive-artifact-registry.js";
import { HybridAgentEngine } from "../src/engine.js";
import { transcriptAsJson, transcriptAsMarkdown, transcriptAsTrajectory } from "../src/runtime/transcript-export.js";

const engines: HybridAgentEngine[] = [];
afterEach(async () => { await Promise.all(engines.splice(0).map(engine => engine.shutdown())); });

describe("isolated interactive artifacts and hidden turns", () => {
  it("publishes hash-bound HTML, issues ephemeral frame bridges and persists content-free interactions", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-artifact-")), workspace = await mkdtemp(join(tmpdir(), "haf-artifact-workspace-"));
    await writeFile(join(workspace, "widget.html"), `<button onclick="hafArtifact.request('select',{value:'alpha'})">Select</button>`);
    const registry = new InteractiveArtifactRegistry(root);
    const artifact = await registry.publish({ tenantId: "tenant", sessionId: "session", workspacePath: workspace, name: "Selector", sourcePath: "widget.html", allowedActions: ["select"] });
    expect(artifact).toMatchObject({ bytes: expect.any(Number), allowedActions: ["select"], enabled: true });
    const grant = await registry.createFrame({ id: artifact.id, tenantId: "tenant", sessionId: "session" });
    const frame = await registry.renderFrame({ id: artifact.id, tenantId: "tenant", sessionId: "session", workspacePath: workspace, channel: grant.channel });
    expect(frame).toContain("Object.defineProperty(window,'hafArtifact'");
    expect(frame).toContain("parent.postMessage");
    expect(frame).not.toContain("allow-same-origin");
    const accepted = await registry.acceptInteraction({
      artifactId: artifact.id, tenantId: "tenant", sessionId: "session", channel: grant.channel,
      interactionId: "interaction_123456", action: "select", payload: { value: "sensitive widget payload" },
    });
    expect(accepted.duplicate).toBe(false);
    expect(accepted.prompt).toContain("INTERACTIVE_ARTIFACT_EVENT");
    expect((await registry.acceptInteraction({ artifactId: artifact.id, tenantId: "tenant", sessionId: "session", channel: grant.channel, interactionId: "interaction_123456", action: "select", payload: { value: "different" } })).duplicate).toBe(true);
    await expect(registry.acceptInteraction({ artifactId: artifact.id, tenantId: "tenant", sessionId: "session", channel: grant.channel, interactionId: "interaction_999999", action: "delete-all", payload: null })).rejects.toThrow("allowlisted");
    await registry.completeInteraction("interaction_123456", "tenant", { status: "delivered", response: "private model response" });
    const persisted = await readFile(join(root, "artifacts", "interactive.json"), "utf8");
    expect(persisted).not.toContain("sensitive widget payload");
    expect(persisted).not.toContain("private model response");
    expect(persisted).toContain(accepted.interaction.payloadSha256);

    await writeFile(join(workspace, "widget.html"), "<p>changed</p>");
    await expect(registry.renderFrame({ id: artifact.id, tenantId: "tenant", sessionId: "session", workspacePath: workspace, channel: grant.channel })).rejects.toThrow("source changed");
    const replacement = new InteractiveArtifactRegistry(root);
    await expect(replacement.renderFrame({ id: artifact.id, tenantId: "tenant", sessionId: "session", workspacePath: workspace, channel: grant.channel })).rejects.toThrow("missing or expired");
  });

  it("runs artifact interactions as hidden model turns omitted from exports, search and public event visibility", async () => {
    const home = await mkdtemp(join(tmpdir(), "haf-artifact-engine-"));
    const engine = new HybridAgentEngine({
      homePath: home,
      kernelServerScript: resolve(process.cwd(), "../../python/kernel_server.py"),
      sandboxBackend: "local",
      model: { provider: "mock" },
    });
    engines.push(engine);
    const session = await engine.createSession({ tenantId: "tenant" });
    await writeFile(join(session.workspacePath, "widget.html"), "<button>Widget</button>");
    const artifact = await engine.interactiveArtifacts.publish({ tenantId: "tenant", sessionId: session.sessionId, workspacePath: session.workspacePath, name: "Widget", sourcePath: "widget.html", allowedActions: ["submit"] });
    const grant = await engine.interactiveArtifacts.createFrame({ id: artifact.id, tenantId: "tenant", sessionId: session.sessionId });
    const interactionId = "interaction_engine_123";
    const accepted = await engine.interactiveArtifacts.acceptInteraction({ artifactId: artifact.id, tenantId: "tenant", sessionId: session.sessionId, channel: grant.channel, interactionId, action: "submit", payload: { choice: "hidden-choice-needle" } });
    const result = await engine.command({
      protocolVersion: 1, commandId: `artifact:${interactionId}`, clientId: "artifact-test", tenantId: "tenant",
      sessionId: session.sessionId, kind: "artifact.interaction", source: "web", issuedAt: new Date().toISOString(), payload: { text: accepted.prompt },
    });
    expect(result.status).toBe("completed");
    const response = String((result.result as any).finalText ?? "");
    await engine.interactiveArtifacts.completeInteraction(interactionId, "tenant", { status: "delivered", response });
    const snapshot = await engine.session(session.sessionId);
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages.every(message => message.hidden === true)).toBe(true);
    expect(transcriptAsJson(snapshot).messages).toEqual([]);
    expect(transcriptAsMarkdown(snapshot)).not.toContain("hidden-choice-needle");
    expect(transcriptAsTrajectory(snapshot).conversations).toEqual([]);
    expect(await engine.sessionSearch.search("tenant", "hidden-choice-needle")).toEqual([]);
    const events = await engine.readEvents(session.sessionId);
    expect(events.filter(event => event.type === "message.created").every(event => event.visibility === "internal")).toBe(true);
    expect(events.filter(event => event.type === "model.text.delta").every(event => event.visibility === "internal")).toBe(true);
  });

  it("rejects path escape, oversized payload depth and disabled frame grants", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-artifact-guards-")), workspace = await mkdtemp(join(tmpdir(), "haf-artifact-guards-workspace-"));
    await writeFile(join(workspace, "widget.html"), "<p>ok</p>");
    await writeFile(join(workspace, "..", "outside.html"), "<p>outside</p>");
    const registry = new InteractiveArtifactRegistry(root);
    await expect(registry.publish({ tenantId: "tenant", sessionId: "session", workspacePath: workspace, name: "bad", sourcePath: "../outside.html", allowedActions: ["x"] })).rejects.toThrow("escapes");
    const artifact = await registry.publish({ tenantId: "tenant", sessionId: "session", workspacePath: workspace, name: "ok", sourcePath: "widget.html", allowedActions: ["submit"] });
    const grant = await registry.createFrame({ id: artifact.id, tenantId: "tenant", sessionId: "session" });
    let deep: any = "x"; for (let index = 0; index < 10; index++) deep = { child: deep };
    await expect(registry.acceptInteraction({ artifactId: artifact.id, tenantId: "tenant", sessionId: "session", channel: grant.channel, interactionId: "interaction_deep_1", action: "submit", payload: deep })).rejects.toThrow("nesting");
    await registry.setEnabled(artifact.id, "tenant", false);
    await expect(registry.renderFrame({ id: artifact.id, tenantId: "tenant", sessionId: "session", workspacePath: workspace, channel: grant.channel })).rejects.toThrow();
  });
});
