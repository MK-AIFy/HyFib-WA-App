import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptSecret } from "../../packages/shared-core/dist/index.js";
import { pathWithoutNode, runScript, SCRIPTS_DIR } from "./helpers.mjs";

const WRAPPER = join(SCRIPTS_DIR, "verify-channel-key.sh");
const KEY = "0123456789abcdef".repeat(4);
const OTHER_KEY = "fedcba9876543210".repeat(4);
const BAD_KEY = "zzz-bad-key-zzz";
const TOKEN = "EAAB-super-secret-access-token";
const GOOD_PAYLOAD = encryptSecret(TOKEN, KEY);

/** Temp dir with a token-rows file (what the fake psql returns) and an optional env file. */
function fixture(t, { rows = [["c1", GOOD_PAYLOAD]], envFile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rowsFile = join(dir, "rows.tsv");
  writeFileSync(rowsFile, rows.map(([id, payload]) => `${id}\t${payload}\n`).join(""));
  const envPath = join(dir, "hyfib.env");
  if (envFile !== undefined) {
    writeFileSync(envPath, envFile);
  }
  return { rowsFile, envPath };
}

const out = (result) => result.stdout + result.stderr;

function assertNoSecrets(result) {
  for (const secret of [KEY, OTHER_KEY, BAD_KEY, TOKEN, GOOD_PAYLOAD]) {
    assert.ok(!out(result).includes(secret), `output leaked a secret (${secret.slice(0, 8)}…)`);
  }
}

test("right key in the environment -> verified, exit 0", (t) => {
  const { rowsFile, envPath } = fixture(t);
  const r = runScript(WRAPPER, ["testdb"], {
    env: { CHANNEL_ENCRYPTION_KEY: KEY, FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: envPath }
  });
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /channel tokens decryptable: 1\/1/);
  assertNoSecrets(r);
});

test("wrong key -> ERROR with both fixes and the failing channel id, exit 3", (t) => {
  const { rowsFile, envPath } = fixture(t);
  const r = runScript(WRAPPER, ["testdb"], {
    env: { CHANNEL_ENCRYPTION_KEY: OTHER_KEY, FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: envPath }
  });
  assert.equal(r.status, 3, out(r));
  assert.match(out(r), /decryptable: 0\/1/);
  assert.match(out(r), /FAILED {2}c1 {2}authentication failed/);
  assert.match(out(r), /ERROR: not all stored channel tokens can be decrypted/);
  assert.match(out(r), /ORIGINAL CHANNEL_ENCRYPTION_KEY/);
  assert.match(out(r), /PATCH \/api\/v1\/channels\/whatsapp/);
  assertNoSecrets(r);
});

test("an unusable key -> ERROR 'unusable' without echoing the key, exit 3", (t) => {
  const { rowsFile, envPath } = fixture(t);
  const r = runScript(WRAPPER, ["testdb"], {
    env: { CHANNEL_ENCRYPTION_KEY: BAD_KEY, FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: envPath }
  });
  assert.equal(r.status, 3, out(r));
  assert.match(out(r), /unusable/);
  assertNoSecrets(r);
});

test("no key in the environment or the env file -> NOTE with the later-verification command, exit 0", (t) => {
  const { rowsFile, envPath } = fixture(t); // env file deliberately absent
  const r = runScript(WRAPPER, ["testdb"], { env: { FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: envPath } });
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /NOTE: CHANNEL_ENCRYPTION_KEY is not available/);
  assert.match(out(r), /NOT verified/);
  assert.match(out(r), /verify-channel-key\.sh testdb/);
  assert.doesNotMatch(out(r), /decryptable:/);
});

test("the key is read from the env file: unquoted, double-quoted, single-quoted, padded, last line wins", (t) => {
  const variants = {
    unquoted: `CHANNEL_ENCRYPTION_KEY=${KEY}\n`,
    doubleQuoted: `CHANNEL_ENCRYPTION_KEY="${KEY}"\n`,
    singleQuoted: `CHANNEL_ENCRYPTION_KEY='${KEY}'\n`,
    padded: `CHANNEL_ENCRYPTION_KEY=${KEY}   \n`,
    lastWins: `# comment\n#CHANNEL_ENCRYPTION_KEY=wrong\nOTHER=1\nCHANNEL_ENCRYPTION_KEY=${OTHER_KEY}\nCHANNEL_ENCRYPTION_KEY=${KEY}\n`
  };
  for (const [name, envFile] of Object.entries(variants)) {
    const { rowsFile, envPath } = fixture(t, { envFile });
    const r = runScript(WRAPPER, ["testdb"], { env: { FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: envPath } });
    assert.equal(r.status, 0, `${name}: ${out(r)}`);
    assert.match(out(r), /decryptable: 1\/1/, name);
  }
});

test("the environment variable takes precedence over the env file", (t) => {
  const { rowsFile, envPath } = fixture(t, { envFile: `CHANNEL_ENCRYPTION_KEY=${OTHER_KEY}\n` });
  const r = runScript(WRAPPER, ["testdb"], {
    env: { CHANNEL_ENCRYPTION_KEY: KEY, FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: envPath }
  });
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /decryptable: 1\/1/);
});

test("a role that does not bypass RLS -> WARNING 'NOT verified', never a false OK, exit 0", (t) => {
  const { rowsFile, envPath } = fixture(t);
  const r = runScript(WRAPPER, ["testdb"], {
    env: { CHANNEL_ENCRYPTION_KEY: KEY, FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: envPath, FAKE_PSQL_BYPASS: "f" }
  });
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /subject to row-level security/);
  assert.match(out(r), /NOT verified/);
  assert.doesNotMatch(out(r), /decryptable:/);
});

test("no stored tokens -> 'nothing to verify', exit 0", (t) => {
  const { rowsFile, envPath } = fixture(t, { rows: [] });
  const r = runScript(WRAPPER, ["testdb"], {
    env: { CHANNEL_ENCRYPTION_KEY: KEY, FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: envPath }
  });
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /nothing to verify/);
});

test("node not available -> WARNING 'cannot verify', exit 0", (t) => {
  const { rowsFile, envPath } = fixture(t);
  const r = runScript(WRAPPER, ["testdb"], {
    env: { CHANNEL_ENCRYPTION_KEY: KEY, FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: envPath },
    path: pathWithoutNode()
  });
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /WARNING: cannot verify channel tokens/);
  assert.doesNotMatch(out(r), /decryptable:/);
});

test("database unreachable -> ERROR, exit 1", (t) => {
  const { rowsFile, envPath } = fixture(t);
  const r = runScript(WRAPPER, ["testdb"], {
    env: { CHANNEL_ENCRYPTION_KEY: KEY, FAKE_PSQL_ROWS_FILE: rowsFile, HYFIB_ENV_FILE: envPath, FAKE_PSQL_FAIL: "1" }
  });
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /cannot query database 'testdb'/);
});
