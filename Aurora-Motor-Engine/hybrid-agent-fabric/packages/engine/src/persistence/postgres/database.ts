import pg from "pg";

export interface PgQueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface PgClientLike {
  query<T = any>(text: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  release(): void;
  on?(event: "notification" | "error", listener: (value: any) => void): unknown;
}

export interface PgPoolLike {
  query<T = any>(text: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  connect(): Promise<PgClientLike>;
  end?(): Promise<void>;
}

export interface PostgresDatabaseOptions {
  connectionString?: string;
  pool?: PgPoolLike;
  schema?: string;
  enableNotify?: boolean;
  enableRls?: boolean;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  return value;
}

export class PostgresDatabase {
  readonly pool: PgPoolLike;
  readonly schema: string;
  readonly enableNotify: boolean;
  readonly enableRls: boolean;
  private schemaPromise: Promise<void> | undefined;
  private ownsPool: boolean;

  constructor(options: PostgresDatabaseOptions) {
    this.schema = identifier(options.schema ?? "haf");
    this.enableNotify = options.enableNotify ?? true;
    this.enableRls = options.enableRls ?? false;
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      if (!options.connectionString) throw new Error("PostgreSQL connectionString or pool is required.");
      this.pool = new pg.Pool({ connectionString: options.connectionString, max: 20 });
      this.ownsPool = true;
    }
  }

  table(name: string): string {
    return `"${this.schema}"."${identifier(name)}"`;
  }

  async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) this.schemaPromise = this.migrate();
    return await this.schemaPromise;
  }

  private async migrate(): Promise<void> {
    const s = `"${this.schema}"`;
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("schema_migrations")} (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`INSERT INTO ${this.table("schema_migrations")}(version) VALUES (1) ON CONFLICT DO NOTHING`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("events")} (
        event_id text PRIMARY KEY,
        tenant_id text NOT NULL,
        session_id text NOT NULL,
        family_id text NOT NULL,
        generation integer NOT NULL,
        sequence bigint NOT NULL,
        turn_id text,
        trace_id text NOT NULL,
        type text NOT NULL,
        timestamp timestamptz NOT NULL,
        visibility text NOT NULL,
        redaction_class text NOT NULL,
        payload jsonb NOT NULL,
        UNIQUE(session_id, sequence)
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS haf_events_session_sequence ON ${this.table("events")}(session_id, sequence)`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("snapshots")} (
        session_id text PRIMARY KEY,
        tenant_id text NOT NULL,
        generation integer NOT NULL,
        last_sequence bigint NOT NULL,
        snapshot jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("command_journal")} (
        journal_key text PRIMARY KEY,
        tenant_id text NOT NULL,
        command_id text NOT NULL,
        owner_id text NOT NULL,
        state text NOT NULL CHECK (state IN ('started','completed')),
        result jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`ALTER TABLE ${this.table("command_journal")} ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'system'`);
    await this.pool.query(`ALTER TABLE ${this.table("command_journal")} ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'legacy'`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("effect_journal")} (
        effect_key text PRIMARY KEY,
        tenant_id text NOT NULL,
        owner_id text NOT NULL,
        state text NOT NULL CHECK (state IN ('started','completed')),
        result jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`ALTER TABLE ${this.table("effect_journal")} ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'system'`);
    await this.pool.query(`ALTER TABLE ${this.table("effect_journal")} ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'legacy'`);
    await this.pool.query(`INSERT INTO ${this.table("schema_migrations")}(version) VALUES (2) ON CONFLICT DO NOTHING`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("session_leases")} (
        session_id text PRIMARY KEY,
        owner_id text NOT NULL,
        expires_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("agent_inbox")} (
        id text PRIMARY KEY,
        command_id text NOT NULL UNIQUE,
        tenant_id text NOT NULL,
        family_id text NOT NULL,
        sender_session_id text NOT NULL,
        sender_name text NOT NULL,
        target_session_id text NOT NULL,
        target_name text NOT NULL,
        relationship text NOT NULL CHECK (relationship IN ('parent','sibling','child')),
        requested_mode text NOT NULL CHECK (requested_mode IN ('auto','steer','follow_up')),
        effective_mode text NOT NULL CHECK (effective_mode IN ('steer','follow_up')),
        text text NOT NULL,
        state text NOT NULL CHECK (state IN ('pending','claimed','delivered','uncertain')),
        owner_id text,
        delivered_at timestamptz,
        uncertain_reason text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS haf_agent_inbox_target_state ON ${this.table("agent_inbox")}(target_session_id, state, created_at)`);
    await this.pool.query(`INSERT INTO ${this.table("schema_migrations")}(version) VALUES (4) ON CONFLICT DO NOTHING`);
    if (this.enableRls) {
      for (const table of ["events", "snapshots", "command_journal", "effect_journal", "agent_inbox"] as const) {
        const qualified = this.table(table);
        const policy = `haf_${table}_tenant_isolation`;
        await this.pool.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`);
        await this.pool.query(`DROP POLICY IF EXISTS "${policy}" ON ${qualified}`);
        await this.pool.query(`
          CREATE POLICY "${policy}" ON ${qualified}
          USING (
            current_setting('haf.system_bypass', true) = 'on'
            OR tenant_id = current_setting('haf.tenant_id', true)
          )
          WITH CHECK (
            current_setting('haf.system_bypass', true) = 'on'
            OR tenant_id = current_setting('haf.tenant_id', true)
          )
        `);
      }
      await this.pool.query(`INSERT INTO ${this.table("schema_migrations")}(version) VALUES (3) ON CONFLICT DO NOTHING`);
    }
  }

  async withTenant<T>(tenantId: string, operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    if (!tenantId || tenantId.length > 200) throw new Error("Tenant context is invalid.");
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('haf.system_bypass','off',true)");
      await client.query("SELECT set_config('haf.tenant_id',$1,true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async withSystemBypass<T>(operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('haf.system_bypass','on',true)");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end?.();
  }
}
