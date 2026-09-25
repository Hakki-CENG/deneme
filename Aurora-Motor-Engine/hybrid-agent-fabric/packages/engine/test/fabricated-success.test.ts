/**
 * Regression guard: services must not fabricate success.
 *
 * A repeated defect class across this codebase was the stub that reports
 * success. Unlike a missing feature, it is invisible to the caller: the action
 * is recorded as completed, the gate is recorded as passed, and nothing
 * upstream can tell the difference.
 *
 * Instances found and fixed:
 *   - `reward-hacking-defense`   every check `async () => true`
 *   - `code-pipeline-service`    security score 100, CI green, deploy success
 *   - `federated-service`        `checkResidency()` always true
 *   - `connector-service`        `dispatchAction()` → `{ success: true }`
 *   - `digital-twin-service`     `sync()` → `{ synced: true }` + fresh timestamp
 *   - `computer-use-service`     every step reported as performed
 *   - `multimodal-service`       placeholder strings returned as OCR output
 *
 * These tests pin the honest behaviour so the pattern cannot silently return.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConnectorService } from "../src/connectors/connector-service.js";
import { DigitalTwinService } from "../src/digital-twin/digital-twin-service.js";

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("connector actions fail instead of reporting phantom success", () => {
  it("records an unimplemented action as failed, not completed", async () => {
    const connectors = new ConnectorService(await tempRoot("haf-connector-"));
    const connector = await connectors.registerConnector(
      "t",
      "email",
      "Test mail",
      "imap",
      "cred-ref",
    );

    const action = await connectors
      .executeAction(connector.id, "email.send", { to: ["a@example.com"] })
      .catch((error: unknown) => error);

    // Either it throws, or it returns a record — but that record must not
    // claim completion.
    if (action instanceof Error) {
      expect(action.message).toContain("not implemented");
      return;
    }

    expect((action as { status: string }).status).not.toBe("completed");
    expect((action as { status: string }).status).toBe("failed");
  });
});

describe("digital twin sync does not stamp a false freshness timestamp", () => {
  it("refuses to sync and leaves lastSyncedAt untouched", async () => {
    const twins = new DigitalTwinService(await tempRoot("haf-twin-"));
    const twin = await twins.createTwin("t", "Owner");
    const before = twin.lastSyncedAt;

    await expect(twins.sync("t")).rejects.toThrow(/not implemented/i);

    const after = await twins.getTwin("t");
    // The critical property: a failed sync must not look like a fresh one.
    expect(after?.lastSyncedAt).toBe(before);
  });
});
