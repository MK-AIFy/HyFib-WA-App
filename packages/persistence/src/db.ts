import pg from "pg";
import { loadConfig } from "@hyfib/config";

const { Pool } = pg;

let pool: pg.Pool | undefined;

/**
 * Lazily-initialised connection pool. The application connects as a
 * dedicated, non-superuser role (`hyfib_app`) so that the row-level
 * security policies defined in the schema are actually enforced —
 * superusers and table owners would otherwise bypass RLS.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    const db = loadConfig().database;
    pool = new Pool({
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
      max: db.poolMax,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl: db.ssl ? { rejectUnauthorized: db.sslRejectUnauthorized } : undefined,
      application_name: "hyfib-platform"
    });
    pool.on("error", (err) => {
      // A pooled client errored while idle; log to stderr so the pool can recover.
      process.stderr.write(`${JSON.stringify({ level: "error", component: "persistence", message: "pool_client_error", error: err.message })}\n`);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export interface QueryClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: readonly unknown[]): Promise<pg.QueryResult<T>>;
}

/**
 * Runs `fn` inside a transaction with the tenant context set via
 * `set_config('app.tenant_id', ...)`. The setting is transaction-local
 * (third arg `true`), so it is automatically discarded on COMMIT/ROLLBACK
 * and never leaks onto a pooled connection reused by another tenant.
 */
export async function withTenant<T>(tenantId: string, fn: (client: QueryClient) => Promise<T>): Promise<T> {
  if (!tenantId) {
    throw new Error("withTenant requires a tenantId");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Direct pool query for tables that are not tenant-scoped (e.g. `tenants`,
 * which has no RLS policy and is only reachable by platform owners).
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: readonly unknown[]
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

export async function healthCheck(): Promise<boolean> {
  const result = await query<{ ok: number }>("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}
