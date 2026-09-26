import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScript, SCRIPTS_DIR } from "./helpers.mjs";

/**
 * scripts/migrate.sh against the fake psql/pg_dump in fake-bin: which migrations it applies and in what order,
 * the lock_timeout every migration statement runs under, the read-only --pending listing, and the --backup-first
 * backup deploy/oracle/deploy.sh takes before a deploy changes the schema. Fixture migrations stand in for
 * infra/postgres/init (MIGRATIONS_DIR), so none of this depends on the real ones.
 */

const MIGRATE = join(SCRIPTS_DIR, "migrate.sh");

function fixture(t, { applied = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const migrations = join(dir, "migrations");
  mkdirSync(migrations);
  writeFileSync(join(migrations, "001_first.sql"), "SELECT 1;\n");
  // A .sh migration connects on its own, as 002_app_role.sh does: it must run under the same lock_timeout.
  writeFileSync(
    join(migrations, "002_role.sh"),
    "#!/bin/sh\npsql -v ON_ERROR_STOP=1 -c \"SELECT 'from 002_role.sh'\"\n"
  );
  writeFileSync(join(migrations, "003_third.sql"), "SELECT 3;\n");
  writeFileSync(join(migrations, "README.md"), "not a migration\n");
  const appliedFile = join(dir, "applied.txt");
  writeFileSync(appliedFile, applied.map((name) => `${name}\n`).join(""));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const backups = join(dir, "backups");
  return {
    backups,
    env: { MIGRATIONS_DIR: migrations, FAKE_PSQL_APPLIED_FILE: appliedFile, FAKE_PSQL_LOG: log, BACKUP_DIR: backups },
    /** Every psql/pg_dump invocation, in order: the PGOPTIONS it ran with, and its arguments. */
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ pgoptions: line.slice(0, line.indexOf("|")), args: line.slice(line.indexOf("|") + 1) }))
  };
}

const out = (r) => r.stdout + r.stderr;
/** A statement that applies a migration or records it as applied. */
const isMigrationStatement = (call) =>
  / -f \S+\.sql$/.test(call.args) ||
  call.args.includes("from 002_role.sh") ||
  call.args.includes("INSERT INTO schema_migrations");
const isBackup = (call) => call.args.startsWith("pg_dump ");

test("applies each pending migration once, in filename order, and records it; applied ones and other files are skipped", (t) => {
  const f = fixture(t, { applied: ["001_first.sql"] });
  const r = runScript(MIGRATE, [], { env: f.env });
  assert.equal(r.status, 0, out(r));

  const args = f.calls().map((call) => call.args);
  const ran = args
    .filter((a) => / -f \S+\.sql$/.test(a) || a.includes("from 002_role.sh"))
    .map((a) => a.match(/(\d{3}_\w+\.sql)$/)?.[1] ?? "002_role.sh");
  assert.deepEqual(ran, ["002_role.sh", "003_third.sql"]);
  const recorded = args
    .filter((a) => a.includes("INSERT INTO schema_migrations"))
    .map((a) => a.match(/VALUES \('([^']+)'\)/)[1]);
  assert.deepEqual(recorded, ["002_role.sh", "003_third.sql"]);
  assert.match(r.stdout, /Migrations complete: 2 applied, 1 already up to date\./);
});

test("--pending lists the migrations not yet applied, one per line, and applies nothing", (t) => {
  const f = fixture(t, { applied: ["001_first.sql"] });
  const r = runScript(MIGRATE, ["--pending"], { env: f.env });
  assert.equal(r.status, 0, out(r));
  assert.equal(r.stdout, "002_role.sh\n003_third.sql\n");
  assert.equal(f.calls().some(isMigrationStatement), false, "nothing applied or recorded");
});

test("--pending prints nothing when the database is up to date", (t) => {
  const f = fixture(t, { applied: ["001_first.sql", "002_role.sh", "003_third.sql"] });
  const r = runScript(MIGRATE, ["--pending"], { env: f.env });
  assert.equal(r.status, 0, out(r));
  assert.equal(r.stdout, "");
});

test("every migration statement waits at most 5 s for a lock, a .sh migration's own psql calls included", (t) => {
  const f = fixture(t);
  const r = runScript(MIGRATE, [], { env: f.env });
  assert.equal(r.status, 0, out(r));

  const statements = f.calls().filter(isMigrationStatement);
  assert.equal(statements.length, 6, "3 migrations applied, 3 recorded");
  for (const call of statements) {
    assert.equal(call.pgoptions, "-c lock_timeout=5s", call.args);
  }
});

test("MIGRATE_LOCK_TIMEOUT overrides the 5 s, and PGOPTIONS the operator already set is kept", (t) => {
  const f = fixture(t);
  const env = { ...f.env, MIGRATE_LOCK_TIMEOUT: "15s", PGOPTIONS: "-c search_path=public" };
  const r = runScript(MIGRATE, [], { env });
  assert.equal(r.status, 0, out(r));
  for (const call of f.calls().filter(isMigrationStatement)) {
    assert.equal(call.pgoptions, "-c search_path=public -c lock_timeout=15s", call.args);
  }
});

test("--backup-first backs the database up before the first migration, and the backup runs without lock_timeout", (t) => {
  const f = fixture(t, { applied: ["001_first.sql"] });
  const r = runScript(MIGRATE, ["--backup-first"], { env: f.env });
  assert.equal(r.status, 0, out(r));

  const calls = f.calls();
  const backup = calls.findIndex(isBackup);
  assert.notEqual(backup, -1, "a backup was taken");
  assert.ok(backup < calls.findIndex(isMigrationStatement), "before the first migration");
  assert.doesNotMatch(calls[backup].pgoptions, /lock_timeout/, "pg_dump must not give up on a lock after 5 s");

  const files = readdirSync(f.backups);
  assert.equal(files.filter((name) => name.endsWith(".dump")).length, 1, files.join());
  assert.equal(files.filter((name) => name.endsWith(".dump.sha256")).length, 1, files.join());
  assert.match(r.stdout, /backup: done: \S+\.dump$/m, "the dump's path is printed for the deploy log");
  assert.match(r.stdout, /Migrations complete: 2 applied, 1 already up to date\./);
});

test("--backup-first takes no backup when nothing is pending", (t) => {
  const f = fixture(t, { applied: ["001_first.sql", "002_role.sh", "003_third.sql"] });
  const r = runScript(MIGRATE, ["--backup-first"], { env: f.env });
  assert.equal(r.status, 0, out(r));
  assert.equal(f.calls().some(isBackup), false);
  assert.equal(existsSync(f.backups), false);
});

test("--backup-first applies nothing when the backup fails", (t) => {
  const f = fixture(t);
  const r = runScript(MIGRATE, ["--backup-first"], { env: { ...f.env, FAKE_PG_DUMP_FAIL: "1" } });
  assert.notEqual(r.status, 0, out(r));
  assert.equal(f.calls().some(isBackup), true, "the backup was attempted");
  assert.equal(f.calls().some(isMigrationStatement), false, "nothing applied or recorded");
});

test('a failed lookup while listing pending migrations stops the script: it never reads as "not applied"', (t) => {
  const f = fixture(t, { applied: ["001_first.sql", "002_role.sh", "003_third.sql"] });
  const env = { ...f.env, FAKE_PSQL_FAIL_MATCH: "FROM schema_migrations WHERE filename" };
  for (const mode of ["--pending", "--backup-first"]) {
    const r = runScript(MIGRATE, [mode], { env });
    assert.notEqual(r.status, 0, `${mode}: ${out(r)}`);
    assert.equal(r.stdout.includes("001_first.sql"), false, `${mode}: an applied migration was listed as pending`);
  }
  assert.equal(f.calls().some(isBackup), false, "no backup taken on a lookup that failed");
  assert.equal(f.calls().some(isMigrationStatement), false, "nothing applied or recorded");
});

test("an unknown argument prints the usage and exits 2 without touching the database", (t) => {
  const f = fixture(t);
  const r = runScript(MIGRATE, ["--bogus"], { env: f.env });
  assert.equal(r.status, 2, out(r));
  assert.match(r.stderr, /usage: migrate\.sh \[--pending \| --backup-first\]/);
  assert.equal(f.calls().length, 0);
});
