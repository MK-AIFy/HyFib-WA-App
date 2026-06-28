import pg from "pg";
import { loadConfig } from "@hyfib/config";
import { Logger } from "@hyfib/shared-core";

const { Pool } = pg;
const config = loadConfig();
const logger = new Logger("db", config.logLevel as "debug" | "info" | "warn" | "error");

let pool: InstanceType<typeof Pool> | undefined;

export type Row = Record<string, unknown>;

export function getPool(): InstanceType<typeof Pool> {
  if (!pool) {
    const { host, port, user, password, database, poolMax, ssl, sslRejectUnauthorized } = config.database;
    pool = new Pool({
      host,
      port,
      user,
      password,
      database,
      max: poolMax,
      ssl: ssl ? { rejectUnauthorized: sslRejectUnauthorized } : false,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
    });
    pool.on("error", (error) => {
      logger.error("pool_error", { error: error instanceof Error ? error.message : String(error) });
    });
  }
  return pool;
}

export async function query<T = Row>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
  const result = await getPool().query(sql, params as unknown[]);
  return result.rows as T[];
}

export async function queryOne<T = Row>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export interface TenantTx {
  query<T = Row>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]>;
  queryOne<T = Row>(sql: string, params?: ReadonlyArray<unknown>): Promise<T | undefined>;
}

class TenantTxImpl implements TenantTx {
  constructor(private readonly client: pg.PoolClient) {}

  async query<T = Row>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
    const result = await this.client.query(sql, params as unknown[]);
    return result.rows as T[];
  }

  async queryOne<T = Row>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T | undefined> {
    const result = await this.client.query(sql, params as unknown[]);
    return (result.rows[0] ?? undefined) as T | undefined;
  }
}

export async function withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("withTenant requires a tenantId string");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const tx = new TenantTxImpl(client);
    const value = await fn(tx);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error("rollback_failed", {
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function withAdmin<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const tx = new TenantTxImpl(client);
    const value = await fn(tx);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error("rollback_failed", {
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function ping(): Promise<boolean> {
  try {
    const result = await getPool().query("SELECT 1 AS ok");
    return (result.rows[0] as Row | undefined)?.ok === 1;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function waitForReady(maxAttempts = 60, delayMs = 1000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await ping()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Database did not become ready in time");
}
