import { describe, expect, it } from "vitest";
import { PostgresDatabase, type PgClientLike, type PgPoolLike } from "../src/persistence/postgres/database.js";

class RecordingClient implements PgClientLike {
  statements: Array<{ sql: string; values?: unknown[] }> = [];
  async query<T = any>(sql: string, values?: unknown[]) { this.statements.push({ sql, values }); return { rows: [] as T[], rowCount: 0 }; }
  release() {}
}
class RecordingPool implements PgPoolLike {
  statements: Array<{ sql: string; values?: unknown[] }> = [];
  clients: RecordingClient[] = [];
  async query<T = any>(sql: string, values?: unknown[]) { this.statements.push({ sql, values }); return { rows: [] as T[], rowCount: 0 }; }
  async connect() { const client = new RecordingClient(); this.clients.push(client); return client; }
}

describe("PostgreSQL tenant RLS migration and context", () => {
  it("creates tenant policies and scopes request transactions", async () => {
    const pool = new RecordingPool();
    const database = new PostgresDatabase({ pool, schema: "tenant_test", enableNotify: false, enableRls: true });
    await database.ensureSchema();
    const migrationSql = pool.statements.map((item) => item.sql).join("\n");
    expect((migrationSql.match(/ENABLE ROW LEVEL SECURITY/g) ?? [])).toHaveLength(5);
    expect(migrationSql).toContain('"agent_inbox" ENABLE ROW LEVEL SECURITY');
    expect(migrationSql).toContain("current_setting('haf.tenant_id', true)");
    expect(migrationSql).toContain("current_setting('haf.system_bypass', true)");

    const result = await database.withTenant("engineering", async (client) => {
      await client.query("SELECT * FROM tenant_test.events");
      return "ok";
    });
    expect(result).toBe("ok");
    const statements = pool.clients[0]!.statements;
    expect(statements.map((item) => item.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('haf.system_bypass','off',true)",
      "SELECT set_config('haf.tenant_id',$1,true)",
      "SELECT * FROM tenant_test.events",
      "COMMIT",
    ]);
    expect(statements[2]!.values).toEqual(["engineering"]);
  });
});
