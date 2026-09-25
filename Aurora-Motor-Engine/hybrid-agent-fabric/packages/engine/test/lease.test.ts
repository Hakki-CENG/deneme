import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionLeaseManager } from "../src/persistence/session-lease.js";

describe("session leases", () => {
  it("prevents two live owners and allows acquisition after release", async () => {
    const root = await mkdtemp(join(tmpdir(), "haf-lease-"));
    const first = new SessionLeaseManager(root);
    const second = new SessionLeaseManager(root);
    await first.acquire("session");
    await expect(second.acquire("session")).rejects.toThrow("already active");
    await first.release("session");
    await second.acquire("session");
    await second.releaseAll();
  });
});
