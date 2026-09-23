import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { query, closePool } from "../dist/index.js";

/**
 * Every SECURITY DEFINER function runs with the privileges of its owner — the bootstrap superuser that runs
 * the init scripts — so it bypasses row-level security by design. Postgres grants EXECUTE on a new function
 * to PUBLIC by default, which means any role that can merely connect inherits those entry points:
 * find_user_by_email_for_auth returns the stored password hash, record_link_click and the outbox_* functions
 * mutate. 034 revokes PUBLIC on the twelve that existed then.
 *
 * The first test is the part that keeps mattering: it re-derives the list from the migration files every run,
 * so a NEW SECURITY DEFINER function added later without a REVOKE fails here rather than shipping open. It
 * needs no database. The rest assert the same thing about a live database and are gated on RUN_DB_TESTS.
 */

const INIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "infra", "postgres", "init");

/** Every function defined with SECURITY DEFINER, as {name, args} taken from the last definition seen. */
function securityDefinerFunctions() {
  const found = new Map();
  for (const file of readdirSync(INIT_DIR).sort()) {
    if (!file.endsWith(".sql")) {
      continue;
    }
    const sql = readFileSync(join(INIT_DIR, file), "utf8");
    // Each CREATE [OR REPLACE] FUNCTION starts a new chunk that runs to the next one, so SECURITY DEFINER
    // is attributed to the function it actually belongs to rather than to whichever was seen last.
    for (const chunk of sql.split(/(?=CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION)/i)) {
      const header = chunk.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_0-9]+)\s*\(([^)]*)\)/i);
      if (!header || !/SECURITY\s+DEFINER/i.test(chunk)) {
        continue;
      }
      found.set(header[1], { name: header[1], args: header[2], file });
    }
  }
  return [...found.values()];
}

/** All privilege statements across the migrations, normalised to {action, fn, role}. */
function privilegeStatements() {
  const statements = [];
  for (const file of readdirSync(INIT_DIR).sort()) {
    if (!file.endsWith(".sql")) {
      continue;
    }
    const sql = readFileSync(join(INIT_DIR, file), "utf8");
    const pattern =
      /(GRANT|REVOKE)\s+EXECUTE\s+ON\s+FUNCTION\s+([a-z_0-9]+)\s*\(([^)]*)\)\s+(?:TO|FROM)\s+([a-z_0-9]+)/gi;
    for (const match of sql.matchAll(pattern)) {
      statements.push({ action: match[1].toUpperCase(), fn: match[2], role: match[4].toLowerCase(), file });
    }
  }
  return statements;
}

test("every SECURITY DEFINER function has EXECUTE revoked from PUBLIC and granted to the app role", () => {
  const functions = securityDefinerFunctions();
  assert.ok(functions.length > 0, "the parser must find the SECURITY DEFINER functions at all");

  const statements = privilegeStatements();
  const missingRevoke = [];
  const missingGrant = [];
  for (const fn of functions) {
    const revoked = statements.some((s) => s.action === "REVOKE" && s.fn === fn.name && s.role === "public");
    const granted = statements.some((s) => s.action === "GRANT" && s.fn === fn.name && s.role === "hyfib_app");
    if (!revoked) {
      missingRevoke.push(`${fn.name} (${fn.file})`);
    }
    if (!granted) {
      missingGrant.push(`${fn.name} (${fn.file})`);
    }
  }

  assert.deepEqual(
    missingRevoke,
    [],
    `SECURITY DEFINER functions still executable by PUBLIC — add REVOKE EXECUTE ... FROM PUBLIC in a migration:\n  ${missingRevoke.join("\n  ")}`
  );
  assert.deepEqual(
    missingGrant,
    [],
    `SECURITY DEFINER functions the app role cannot call — revoking PUBLIC would break them:\n  ${missingGrant.join("\n  ")}`
  );
});

test("the revoke list matches the functions exactly, with no stale entries", () => {
  // A REVOKE naming a function that no longer exists is dead weight that hides a real gap in review.
  const names = new Set(securityDefinerFunctions().map((fn) => fn.name));
  const revokedNames = privilegeStatements()
    .filter((s) => s.action === "REVOKE" && s.role === "public")
    .map((s) => s.fn);

  const stale = [...new Set(revokedNames)].filter((name) => !names.has(name));
  assert.deepEqual(stale, [], `REVOKE statements for functions that are not SECURITY DEFINER: ${stale.join(", ")}`);
});

// ─── Live database ───────────────────────────────────────────────────────────
// Require a database with every migration applied. CI provides one; locally: RUN_DB_TESTS=1.
const skip = !process.env.RUN_DB_TESTS;

test("PUBLIC holds no EXECUTE on any SECURITY DEFINER function", { skip }, async () => {
  const result = await query(
    `SELECT p.proname, array_to_string(p.proacl, ',') AS acl
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef
        AND p.proacl IS NOT NULL`
  );
  assert.ok(result.rows.length > 0, "the database must actually have the SECURITY DEFINER functions applied");

  // An ACL entry with an empty grantee ("=X/owner") is the PUBLIC grant.
  const open = result.rows.filter((row) => /(^|,)=[a-zA-Z]*X/.test(row.acl)).map((row) => row.proname);
  assert.deepEqual(open, [], `these run as their owner and are callable by PUBLIC: ${open.join(", ")}`);
});

test("the hot-path indexes exist and are valid", { skip }, async () => {
  const result = await query(
    `SELECT c.relname, i.indisvalid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('idx_messages_external_message_id', 'idx_sequence_enrollments_contact_active')`
  );

  const byName = new Map(result.rows.map((row) => [row.relname, row.indisvalid]));
  for (const name of ["idx_messages_external_message_id", "idx_sequence_enrollments_contact_active"]) {
    assert.ok(byName.has(name), `${name} is missing; the inbound replay guard and stop-on-reply scan without it`);
    assert.equal(byName.get(name), true, `${name} exists but is INVALID — a failed CREATE INDEX CONCURRENTLY`);
  }
});

test("the replay-guard lookup uses its index rather than scanning messages", { skip }, async () => {
  const plan = await query(
    "EXPLAIN (FORMAT JSON) SELECT id FROM messages WHERE external_message_id = 'wamid.probe' LIMIT 1"
  );
  const rendered = JSON.stringify(plan.rows[0]);
  assert.match(
    rendered,
    /idx_messages_external_message_id/,
    `findByExternalId must not sequentially scan messages; plan was: ${rendered}`
  );
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
