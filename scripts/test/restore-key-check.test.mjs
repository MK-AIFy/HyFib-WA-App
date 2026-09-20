import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptSecret } from "../../packages/shared-core/dist/index.js";
import { runScript, SCRIPTS_DIR } from "./helpers.mjs";

const RESTORE = join(SCRIPTS_DIR, "restore.sh");
const KEY = "0123456789abcdef".repeat(4);
const OTHER_KEY = "fedcba9876543210".repeat(4);
const TOKEN = "EAAB-super-secret-access-token";

/** A dump placeholder (the fake pg_restore ignores it) and the rows the fake psql returns. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "restore-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dump = join(dir, "hyfib_wa_test.dump");
  writeFileSync(dump, "");
  const rowsFile = join(dir, "rows.tsv");
  writeFileSync(rowsFile, `c1\t${encryptSecret(TOKEN, KEY)}\n`);
  return { dump, rowsFile, missingEnvFile: join(dir, "no-such-hyfib.env") };
}

const out = (result) => result.stdout + result.stderr;

test("restore.sh: right key -> evidence, 'decryptable: 1/1', final 'done', exit 0", (t) => {
  const { dump, rowsFile, missingEnvFile } = fixture(t);
  const r = runScript(RESTORE, [dump, "testdb"], {
    env: { CHANNEL_ENCRYPTION_KEY: KEY, FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: missingEnvFile }
  });
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /post-restore evidence/);
  assert.match(out(r), /migrations applied: 33/);
  assert.match(out(r), /channel tokens decryptable: 1\/1/);
  assert.match(out(r), /restore: done/);
});

test("restore.sh: wrong key -> ERROR, still prints 'done' AFTER it, exits 3", (t) => {
  const { dump, rowsFile, missingEnvFile } = fixture(t);
  const r = runScript(RESTORE, [dump, "testdb"], {
    env: { CHANNEL_ENCRYPTION_KEY: OTHER_KEY, FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: missingEnvFile }
  });
  assert.equal(r.status, 3, out(r));
  assert.match(out(r), /ERROR: not all stored channel tokens can be decrypted/);
  assert.match(out(r), /restore: done/);
  assert.ok(out(r).indexOf("restore: done") > out(r).indexOf("ERROR:"), "'done' must come after the ERROR block");
  assert.ok(!out(r).includes(KEY) && !out(r).includes(OTHER_KEY) && !out(r).includes(TOKEN), "no secret in output");
});

test("restore.sh: no key anywhere -> NOTE, exit 0 (backward compatible with today's CI drill)", (t) => {
  const { dump, rowsFile, missingEnvFile } = fixture(t);
  const r = runScript(RESTORE, [dump, "testdb"], {
    env: { FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: missingEnvFile }
  });
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /NOTE: CHANNEL_ENCRYPTION_KEY is not available/);
  assert.match(out(r), /restore: done/);
});
