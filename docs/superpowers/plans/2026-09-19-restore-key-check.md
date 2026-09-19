# Restore-time Channel-Key Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `scripts/restore.sh`, tell the operator whether the configured `CHANNEL_ENCRYPTION_KEY` can decrypt the restored WhatsApp channel tokens (exit 3 if not), and document key escrow in the DR runbook — without adding any secret to backups.

**Architecture:** A pure, unit-tested Node checker (`scripts/check-channel-key.mjs`) uses the app's own `decryptSecret`. A thin bash wrapper (`scripts/verify-channel-key.sh`) resolves the key, guards against the FORCE-RLS silent-zero-rows trap, reads the token rows with `psql`, and runs the checker. `restore.sh` calls the wrapper after its evidence block and exits with the wrapper's status. Shell behaviour is tested deterministically by putting a fake `psql` first on `PATH`.

**Tech Stack:** bash (3.2-compatible: macOS local, 5.x on Ubuntu/CI), Node ESM (`.mjs`, `node --test`), `psql`/`pg_dump`/`pg_restore`, Postgres 15 container for the live end-to-end run.

**Spec:** `docs/superpowers/specs/2026-09-19-restore-key-check-design.md`

## Global Constraints

- Checker exit codes: `0` all decryptable or none stored; `1` at least one failed; `2` unusable/missing key or unbuilt shared-core.
- Wrapper exit codes: `0` verified, or could not verify (NOTE/WARNING printed); `3` tokens undecryptable or key unusable; `1` cannot query the database. `restore.sh` prints its final `done`, then exits with the wrapper's status.
- The key travels only in the `CHANNEL_ENCRYPTION_KEY` environment variable of one child process — never argv, never printed, never logged. `hyfib.env` is read for that one variable, never sourced.
- Output contains channel ids and the fixed reason strings `authentication failed` / `malformed` / `error` only — never tokens, keys, ciphertext or raw error text. A stdin line with no tab is reported as `line N`, never echoed.
- The checker uses `encryptSecret`/`decryptSecret` from `packages/shared-core/dist/index.js` (production code path); key usability is proven by an `encryptSecret("probe", key)` probe.
- Nothing is added to backup artifacts; `scripts/backup.sh` is unchanged.
- Backward compatible: `restore.sh` without a key and without `/etc/hyfib/hyfib.env` behaves as before (NOTE, exit 0).
- bash 3.2-compatible: no associative arrays, no `${v,,}`, no `mapfile`; `$'\t'` is fine.
- Prettier (`.prettierrc.json`): printWidth 120, double quotes, no trailing commas, semicolons. ESLint ignores `scripts/**` and `**/*.mjs`; Prettier still checks `.mjs` (it ignores `*.md`).
- CI runs Node 24; `node --test "<glob>"` is supported.
- **Commits: hold.** The user's standing rule is to commit only when asked — every "Commit" step below is prepared but NOT executed until the user says so.
- Never touch other projects' Docker containers or fixed ports; the live run uses one throwaway container on a random localhost port.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `scripts/check-channel-key.mjs` | create | Pure verification + report + CLI entry |
| `scripts/verify-channel-key.sh` | create | Resolve key, RLS guard, read rows, run checker, map exit codes |
| `scripts/restore.sh` | modify (end + header) | Call the wrapper, keep `done`, exit with its status |
| `scripts/test/helpers.mjs` | create | Run scripts with a controlled `PATH`/env |
| `scripts/test/fake-bin/psql` | create | Test double for `psql` |
| `scripts/test/fake-bin/pg_restore` | create | Test double for `pg_restore` |
| `scripts/test/check-channel-key.test.mjs` | create | Checker unit + CLI tests |
| `scripts/test/verify-channel-key.test.mjs` | create | Wrapper tests (fake psql) |
| `scripts/test/restore-key-check.test.mjs` | create | `restore.sh` integration tests (fake psql/pg_restore) |
| `package.json` (root) | modify line 15 | `test` also runs the scripts tests |
| `docs/runbooks/dr-drill.md` | rewrite | DR-critical secrets, current topology, drill steps |
| `deploy/oracle/README.md` | modify (2 table rows) | Pointers to the runbook section |

---

## Task 1: The checker (`scripts/check-channel-key.mjs`) and its tests

**Files:**

- Create: `scripts/check-channel-key.mjs`
- Create: `scripts/test/check-channel-key.test.mjs`
- Modify: `package.json:15`

**Interfaces:**

- Produces (used by Tasks 2–3 and the tests):
  - `verifyChannelTokens(rows: {id: string, payload: string}[], key: string, deps: {decrypt: (payload: string, key: string) => string}): {total: number, ok: number, failed: {id: string, reason: string}[]}`
  - `keyProblem(key: string, deps: {encrypt: (plaintext: string, key: string) => string}): string | undefined`
  - `parseRows(input: string): {id: string, payload: string}[]`
  - `formatReport(result): string[]`
  - `runCheck({input, key, decrypt, encrypt}): {code: number, stdout: string, stderr: string}`
  - CLI: reads stdin TSV, key from `CHANNEL_ENCRYPTION_KEY`, sets `process.exitCode`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/check-channel-key.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decryptSecret, encryptSecret } from "../../packages/shared-core/dist/index.js";
import { formatReport, keyProblem, parseRows, runCheck, verifyChannelTokens } from "../check-channel-key.mjs";

const KEY = "0123456789abcdef".repeat(4); // 64 hex characters = 32 bytes
const OTHER_KEY = "fedcba9876543210".repeat(4);
const BASE64_KEY = Buffer.alloc(32, 7).toString("base64");
const BAD_KEY = "zzz-bad-key-zzz";
const TOKEN = "EAAB-super-secret-access-token";
const CHECKER = fileURLToPath(new URL("../check-channel-key.mjs", import.meta.url));
const deps = { decrypt: decryptSecret, encrypt: encryptSecret };

function tsv(rows) {
  return rows.map(({ id, payload }) => `${id}\t${payload}\n`).join("");
}

function goodRows() {
  return tsv([
    { id: "c1", payload: encryptSecret(TOKEN, KEY) },
    { id: "c2", payload: encryptSecret("another-token", KEY) }
  ]);
}

function runCli(input, key) {
  const { CHANNEL_ENCRYPTION_KEY: _inherited, ...rest } = process.env;
  const env = key === undefined ? rest : { ...rest, CHANNEL_ENCRYPTION_KEY: key };
  return spawnSync(process.execPath, [CHECKER], { input, env, encoding: "utf8" });
}

test("verifyChannelTokens: every token decrypts with the right key", () => {
  const rows = [
    { id: "c1", payload: encryptSecret(TOKEN, KEY) },
    { id: "c2", payload: encryptSecret("another-token", KEY) }
  ];
  assert.deepEqual(verifyChannelTokens(rows, KEY, deps), { total: 2, ok: 2, failed: [] });
});

test("verifyChannelTokens: a different key fails every token as 'authentication failed'", () => {
  const rows = [
    { id: "c1", payload: encryptSecret(TOKEN, KEY) },
    { id: "c2", payload: encryptSecret("another-token", KEY) }
  ];
  assert.deepEqual(verifyChannelTokens(rows, OTHER_KEY, deps), {
    total: 2,
    ok: 0,
    failed: [
      { id: "c1", reason: "authentication failed" },
      { id: "c2", reason: "authentication failed" }
    ]
  });
});

test("verifyChannelTokens: payloads that are not valid v1 tokens fail as 'malformed'", () => {
  const rows = [
    { id: "junk", payload: "not-a-token" },
    { id: "short-tag", payload: "v1:AAAA:BBBB:CCCC" },
    { id: "empty", payload: "" }
  ];
  assert.deepEqual(verifyChannelTokens(rows, KEY, deps).failed, [
    { id: "junk", reason: "malformed" },
    { id: "short-tag", reason: "malformed" },
    { id: "empty", reason: "malformed" }
  ]);
});

test("verifyChannelTokens: a mixed set keeps counts, ids and order", () => {
  const rows = [
    { id: "good", payload: encryptSecret(TOKEN, KEY) },
    { id: "rotated", payload: encryptSecret(TOKEN, OTHER_KEY) },
    { id: "junk", payload: "nope" }
  ];
  assert.deepEqual(verifyChannelTokens(rows, KEY, deps), {
    total: 3,
    ok: 1,
    failed: [
      { id: "rotated", reason: "authentication failed" },
      { id: "junk", reason: "malformed" }
    ]
  });
});

test("verifyChannelTokens: no rows is an empty, successful result", () => {
  assert.deepEqual(verifyChannelTokens([], KEY, deps), { total: 0, ok: 0, failed: [] });
  assert.deepEqual(formatReport({ total: 0, ok: 0, failed: [] }), ["no channel tokens stored — nothing to verify"]);
});

test("verifyChannelTokens: an unexpected decrypt error is reported as the fixed reason 'error', never its text", () => {
  const boom = () => {
    throw new Error(`disk on fire: ${TOKEN}`);
  };
  const result = verifyChannelTokens([{ id: "c1", payload: "x" }], KEY, { decrypt: boom });
  assert.deepEqual(result.failed, [{ id: "c1", reason: "error" }]);
  assert.ok(!JSON.stringify(result).includes("disk on fire"), "raw error text must not be returned");
  assert.ok(!JSON.stringify(result).includes(TOKEN), "a token must not be returned");
});

test("keyProblem: accepts a 64-hex-character key and a base64 32-byte key", () => {
  assert.equal(keyProblem(KEY, deps), undefined);
  assert.equal(keyProblem(BASE64_KEY, deps), undefined);
});

test("keyProblem: rejects a missing or malformed key without echoing it", () => {
  assert.match(keyProblem("", deps), /not set/);
  const problem = keyProblem(BAD_KEY, deps);
  assert.match(problem, /not a valid 32-byte key/);
  assert.ok(!problem.includes(BAD_KEY), "the key must never be echoed");
});

test("parseRows: splits on the first tab, ignores blank lines and CRs, never echoes an unparseable line", () => {
  const input = "c1\tv1:a:b:c\n\nv1:no:tab:here\r\nc2\tv1:x:y:z\n";
  assert.deepEqual(parseRows(input), [
    { id: "c1", payload: "v1:a:b:c" },
    { id: "line 3", payload: "" },
    { id: "c2", payload: "v1:x:y:z" }
  ]);
});

test("formatReport: summarises the count and lists failing ids with their reason", () => {
  const result = {
    total: 3,
    ok: 1,
    failed: [
      { id: "c2", reason: "authentication failed" },
      { id: "c3", reason: "malformed" }
    ]
  };
  assert.deepEqual(formatReport(result), [
    "channel tokens decryptable: 1/3",
    "FAILED  c2  authentication failed",
    "FAILED  c3  malformed"
  ]);
});

test("runCheck: right key -> exit 0 and an N/N summary", () => {
  assert.deepEqual(runCheck({ input: goodRows(), key: KEY, ...deps }), {
    code: 0,
    stdout: "channel tokens decryptable: 2/2\n",
    stderr: ""
  });
});

test("runCheck: wrong key -> exit 1 listing each failing channel", () => {
  assert.deepEqual(runCheck({ input: goodRows(), key: OTHER_KEY, ...deps }), {
    code: 1,
    stdout: "channel tokens decryptable: 0/2\nFAILED  c1  authentication failed\nFAILED  c2  authentication failed\n",
    stderr: ""
  });
});

test("runCheck: no rows -> exit 0 'nothing to verify'", () => {
  assert.deepEqual(runCheck({ input: "\n", key: KEY, ...deps }), {
    code: 0,
    stdout: "no channel tokens stored — nothing to verify\n",
    stderr: ""
  });
});

test("runCheck: a missing or unusable key -> exit 2 with the error on stderr only", () => {
  const missing = runCheck({ input: goodRows(), key: "", ...deps });
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /^ERROR: .*not set/);

  const bad = runCheck({ input: goodRows(), key: BAD_KEY, ...deps });
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /not a valid 32-byte key/);
});

test("CLI: right key -> exit 0", () => {
  const result = runCli(goodRows(), KEY);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "channel tokens decryptable: 2/2\n");
});

test("CLI: wrong key -> exit 1", () => {
  const result = runCli(goodRows(), OTHER_KEY);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /decryptable: 0\/2/);
});

test("CLI: no key in the environment -> exit 2", () => {
  const result = runCli(goodRows(), undefined);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not set/);
});

test("CLI: neither output stream ever contains a token, a key or a ciphertext", () => {
  const input = goodRows();
  const ciphertexts = input
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]);
  for (const key of [KEY, OTHER_KEY, BAD_KEY, undefined]) {
    const { stdout, stderr } = runCli(input, key);
    const seen = stdout + stderr;
    for (const secret of [TOKEN, KEY, OTHER_KEY, BAD_KEY, ...ciphertexts]) {
      assert.ok(!seen.includes(secret), `output leaked a secret (${secret.slice(0, 8)}…)`);
    }
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/test/check-channel-key.test.mjs`
Expected: FAIL — the file errors on import with `ERR_MODULE_NOT_FOUND` for `scripts/check-channel-key.mjs` (the feature does not exist yet). Confirm the reason is the missing module, not a typo in the test.

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/check-channel-key.mjs`:

```js
#!/usr/bin/env node
// Verifies that CHANNEL_ENCRYPTION_KEY can decrypt WhatsApp channel access tokens read from stdin.
//
// Input : one `<channel-id>\t<encrypted-token>` per line on stdin (the `v1:<iv>:<tag>:<ciphertext>` values
//         stored in whatsapp_channels.access_token_encrypted).
// Key   : the CHANNEL_ENCRYPTION_KEY environment variable — never argv (visible in `ps`), never printed.
// Output: a summary plus the ids (never tokens, keys or ciphertext) of the channels that failed.
// Exit  : 0 every token decrypts (or none stored); 1 at least one failed; 2 unusable key / shared-core not built.
//
// It uses the application's own encryptSecret/decryptSecret (packages/shared-core), so a token this script can
// decrypt is a token the running app can decrypt.
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AUTH_FAILED = "authentication failed";
const MALFORMED = "malformed";
const OTHER = "error";

/** Maps a crypto error to a fixed reason string. The raw message is never returned. */
function classify(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/unable to authenticate data/i.test(message)) {
    return AUTH_FAILED;
  }
  if (/malformed|initialization vector|authentication tag/i.test(message)) {
    return MALFORMED;
  }
  return OTHER;
}

/**
 * Tries to decrypt every row with `key`. Pure: decrypt is injected and nothing but ids and fixed reason
 * strings is ever returned.
 */
export function verifyChannelTokens(rows, key, { decrypt }) {
  const failed = [];
  let ok = 0;
  for (const { id, payload } of rows) {
    try {
      decrypt(payload, key);
      ok += 1;
    } catch (error) {
      failed.push({ id, reason: classify(error) });
    }
  }
  return { total: rows.length, ok, failed };
}

/** Returns a fixed, key-free description of why `key` is unusable, or undefined when it is usable. */
export function keyProblem(key, { encrypt }) {
  if (!key) {
    return "CHANNEL_ENCRYPTION_KEY is not set";
  }
  try {
    encrypt("probe", key);
    return undefined;
  } catch {
    return "CHANNEL_ENCRYPTION_KEY is not a valid 32-byte key (64 hex characters, or base64 of 32 bytes)";
  }
}

/** Parses `<id>\t<payload>` lines. A line without a tab is reported as `line N` and never echoed. */
export function parseRows(input) {
  const rows = [];
  input.split("\n").forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") {
      return;
    }
    const tab = line.indexOf("\t");
    rows.push(tab === -1 ? { id: `line ${index + 1}`, payload: "" } : { id: line.slice(0, tab), payload: line.slice(tab + 1) });
  });
  return rows;
}

export function formatReport(result) {
  if (result.total === 0) {
    return ["no channel tokens stored — nothing to verify"];
  }
  return [
    `channel tokens decryptable: ${result.ok}/${result.total}`,
    ...result.failed.map(({ id, reason }) => `FAILED  ${id}  ${reason}`)
  ];
}

/** The whole check without any I/O: returns what to print and the exit code. */
export function runCheck({ input, key, decrypt, encrypt }) {
  const problem = keyProblem(key, { encrypt });
  if (problem) {
    return { code: 2, stdout: "", stderr: `ERROR: ${problem}\n` };
  }
  const result = verifyChannelTokens(parseRows(input), key, { decrypt });
  return { code: result.failed.length > 0 ? 1 : 0, stdout: `${formatReport(result).join("\n")}\n`, stderr: "" };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8");

  let shared;
  try {
    shared = await import(new URL("../packages/shared-core/dist/index.js", import.meta.url).href);
  } catch {
    process.stderr.write("ERROR: packages/shared-core is not built — run `pnpm build` first\n");
    process.exitCode = 2;
    return;
  }

  const { code, stdout, stderr } = runCheck({
    input,
    key: process.env.CHANNEL_ENCRYPTION_KEY ?? "",
    decrypt: shared.decryptSecret,
    encrypt: shared.encryptSecret
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/test/check-channel-key.test.mjs`
Expected: PASS — 18 tests, 0 fail. If `short-tag` is not classified `malformed`, print the real error message for `v1:AAAA:BBBB:CCCC` and widen `classify()`'s regex to match it (do not weaken the test).

- [ ] **Step 5: Format with Prettier and re-run**

Run: `pnpm exec prettier --write scripts/check-channel-key.mjs scripts/test/check-channel-key.test.mjs && pnpm exec prettier --check scripts/check-channel-key.mjs scripts/test/check-channel-key.test.mjs && node --test scripts/test/check-channel-key.test.mjs`
Expected: `All matched files use Prettier code style!` then 18 pass, 0 fail.

- [ ] **Step 6: Wire the scripts tests into the root `test` script**

Edit `package.json` line 15. Replace

```json
    "test": "pnpm -r test",
```

with

```json
    "test": "pnpm -r test && node --test \"scripts/test/*.test.mjs\"",
```

Run: `node --test "scripts/test/*.test.mjs"`
Expected: the glob is expanded by Node and runs the file(s) that exist so far; 0 fail.

- [ ] **Step 7: Commit (HOLD — only when the user asks)**

```bash
git add scripts/check-channel-key.mjs scripts/test/check-channel-key.test.mjs package.json
git commit -m "feat(scripts): channel-token key checker with unit and CLI tests"
```

---

## Task 2: The wrapper (`scripts/verify-channel-key.sh`) and its tests

**Files:**

- Create: `scripts/test/fake-bin/psql` (executable)
- Create: `scripts/test/fake-bin/pg_restore` (executable)
- Create: `scripts/test/helpers.mjs`
- Create: `scripts/test/verify-channel-key.test.mjs`
- Create: `scripts/verify-channel-key.sh`

**Interfaces:**

- Consumes: Task 1's CLI (`node scripts/check-channel-key.mjs`, stdin TSV, `CHANNEL_ENCRYPTION_KEY` env, exit `0/1/2`).
- Produces:
  - `scripts/verify-channel-key.sh [db]` — env: `POSTGRES_HOST/PORT/USER/PASSWORD` (or already-exported `PG*`), `CHANNEL_ENCRYPTION_KEY`, `HYFIB_ENV_FILE` (default `/etc/hyfib/hyfib.env`). Exits `0`/`3`/`1` as in Global Constraints.
  - `helpers.mjs`: `SCRIPTS_DIR: string`, `runScript(scriptPath: string, args: string[], opts?: {env?: object, path?: string}): SpawnSyncReturns<string>`, `pathWithoutNode(): string`.

- [ ] **Step 1: Create the test doubles**

Create `scripts/test/fake-bin/psql`:

```bash
#!/usr/bin/env bash
# Test double for psql, used by scripts/test/*.test.mjs. Answers are canned per SQL text and driven by
# environment variables the test sets:
#   FAKE_PSQL_FAIL       any value -> behave like an unreachable server (exit 2)
#   FAKE_PSQL_BYPASS     answer to the "does this role bypass RLS" query (default t)
#   FAKE_PSQL_ROWS_FILE  file whose contents answer the whatsapp_channels token query
if [ -n "${FAKE_PSQL_FAIL:-}" ]; then
  echo "psql: error: connection to server failed" >&2
  exit 2
fi
case "$*" in
  *rolsuper*) printf '%s\n' "${FAKE_PSQL_BYPASS:-t}" ;;
  *whatsapp_channels*) if [ -n "${FAKE_PSQL_ROWS_FILE:-}" ]; then cat "$FAKE_PSQL_ROWS_FILE"; fi ;;
  *schema_migrations*) echo "migrations applied: 33" ;;
  *tenants*) echo "tenants: 1" ;;
  *relforcerowsecurity*) echo "RLS forced on contacts: t" ;;
  *) ;;
esac
```

Create `scripts/test/fake-bin/pg_restore`:

```bash
#!/usr/bin/env bash
# Test double for pg_restore: always succeeds.
exit 0
```

Run: `chmod +x scripts/test/fake-bin/psql scripts/test/fake-bin/pg_restore`

- [ ] **Step 2: Create the test helpers**

Create `scripts/test/helpers.mjs`:

```js
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SCRIPTS_DIR = fileURLToPath(new URL("..", import.meta.url));
const FAKE_BIN = fileURLToPath(new URL("./fake-bin", import.meta.url));

function which(tool) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, tool);
    if (dir && existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${tool} not found on PATH`);
}

/**
 * A directory holding only the basic tools the scripts need before they reach `node`, and deliberately
 * no `node` and no `psql` — for testing the "cannot verify" path.
 */
export function pathWithoutNode() {
  const dir = mkdtempSync(join(tmpdir(), "no-node-"));
  for (const tool of ["bash", "env", "dirname", "date", "sed", "tail", "cat"]) {
    symlinkSync(which(tool), join(dir, tool));
  }
  return dir;
}

/**
 * Runs a bash script with a fully controlled environment: the fake psql/pg_restore first on PATH, the
 * running node next, and NONE of the developer's own variables (so a real CHANNEL_ENCRYPTION_KEY can
 * never leak into a test).
 */
export function runScript(scriptPath, args, { env = {}, path } = {}) {
  const searchPath = path ?? [FAKE_BIN, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  return spawnSync("/bin/bash", [scriptPath, ...args], {
    encoding: "utf8",
    env: { PATH: searchPath, HOME: tmpdir(), POSTGRES_USER: "test-user", POSTGRES_PASSWORD: "test-pass", ...env }
  });
}
```

- [ ] **Step 3: Write the failing wrapper tests**

Create `scripts/test/verify-channel-key.test.mjs`:

```js
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
  assert.match(out(r), /PATCH \/api\/v1\/channels/);
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test scripts/test/verify-channel-key.test.mjs`
Expected: FAIL — every test fails because `scripts/verify-channel-key.sh` does not exist (`bash` prints `No such file or directory`, so `r.status` is `127`). Confirm the failure is the missing script, not the helpers.

- [ ] **Step 5: Write the wrapper**

Create `scripts/verify-channel-key.sh`:

```bash
#!/usr/bin/env bash
# Verifies that the configured CHANNEL_ENCRYPTION_KEY can decrypt every WhatsApp channel access token
# stored in the database.
#
# Why: the key lives only in /etc/hyfib/hyfib.env, never in a database dump (and must never be stored
# beside one). A replacement VM generates a NEW random key, so a restored database's channel tokens can
# no longer be decrypted until the original key is put back. Nothing else is lost — the fix is either the
# original key or re-entering each channel's token — but without this check the first sign is failing sends.
#
# Usage: verify-channel-key.sh [db]        (default: $POSTGRES_DB, else hyfib_wa)
#
# Env:
#   POSTGRES_HOST/PORT/USER/PASSWORD  as restore.sh (or already-exported PG* variables). The role must
#                                     be a superuser or have BYPASSRLS: whatsapp_channels is FORCE-RLS,
#                                     and any other role silently reads zero rows.
#   CHANNEL_ENCRYPTION_KEY            the key to test; if unset, read from HYFIB_ENV_FILE
#   HYFIB_ENV_FILE                    default /etc/hyfib/hyfib.env (only that one variable is read; the
#                                     file is never sourced)
#
# Exit: 0 verified, or could not verify (a NOTE/WARNING line says so)
#       3 tokens cannot be decrypted / key unusable
#       1 cannot query the database
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/check-channel-key.mjs"
SHARED_CORE_DIST="$SCRIPT_DIR/../packages/shared-core/dist/index.js"
ENV_FILE="${HYFIB_ENV_FILE:-/etc/hyfib/hyfib.env}"

db="${1:-${POSTGRES_DB:-hyfib_wa}}"

export PGHOST="${PGHOST:-${POSTGRES_HOST:-localhost}}"
export PGPORT="${PGPORT:-${POSTGRES_PORT:-5432}}"
export PGUSER="${PGUSER:-${POSTGRES_USER:?POSTGRES_USER is required}}"
export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}}"

log() { printf '%s verify-key: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Extracts the single CHANNEL_ENCRYPTION_KEY= line's value (last one wins): trims surrounding whitespace,
# then one pair of matching quotes.
read_key_from_env_file() {
  local raw
  raw="$(sed -n 's/^CHANNEL_ENCRYPTION_KEY=//p' "$1" | tail -n 1)"
  raw="$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$raw" in
    \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
    \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
  esac
  printf '%s' "$raw"
}

key="${CHANNEL_ENCRYPTION_KEY:-}"
if [ -z "$key" ] && [ -r "$ENV_FILE" ]; then
  key="$(read_key_from_env_file "$ENV_FILE")"
fi

if [ -z "$key" ]; then
  log "NOTE: CHANNEL_ENCRYPTION_KEY is not available (not in the environment, nor readable from $ENV_FILE) — channel tokens NOT verified."
  log "NOTE: verify later with: sudo bash -c 'set -a; . /etc/hyfib/migrate.env; set +a; bash $SCRIPT_DIR/verify-channel-key.sh $db'"
  exit 0
fi

if ! command -v node >/dev/null 2>&1 || [ ! -f "$SHARED_CORE_DIST" ]; then
  log "WARNING: cannot verify channel tokens — this needs node and a built packages/shared-core (run: pnpm build). Channel tokens NOT verified."
  exit 0
fi

# whatsapp_channels is FORCE-RLS: a role that does not bypass RLS reads zero rows WITHOUT an error, which
# would look exactly like "no tokens stored". Refuse to report anything in that case.
if ! bypass="$(psql -d "$db" -tAc "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")"; then
  log "ERROR: cannot query database '$db' as '$PGUSER'."
  exit 1
fi
if [ "$bypass" != "t" ]; then
  log "WARNING: role '$PGUSER' is subject to row-level security — channel tokens NOT verified (a superuser or BYPASSRLS role is required)."
  exit 0
fi

if ! rows="$(psql -d "$db" -At -F $'\t' -c "SELECT id, access_token_encrypted FROM whatsapp_channels WHERE access_token_encrypted IS NOT NULL ORDER BY id")"; then
  log "WARNING: could not read whatsapp_channels from '$db' — channel tokens NOT verified."
  exit 0
fi

# The key reaches the checker only through its environment; the rows on the pipe are ciphertext.
if report="$(printf '%s\n' "$rows" | CHANNEL_ENCRYPTION_KEY="$key" node "$CHECKER" 2>&1)"; then
  status=0
else
  status=$?
fi

while IFS= read -r line; do
  log "$line"
done <<< "$report"

case "$status" in
  0)
    exit 0
    ;;
  1)
    summary="$(printf '%s\n' "$report" | sed -n '1p')"
    log "ERROR: not all stored channel tokens can be decrypted with the configured CHANNEL_ENCRYPTION_KEY (${summary})."
    log "ERROR: outbound sends on the failing channels will fail until ONE of:"
    log "  (a) the ORIGINAL CHANNEL_ENCRYPTION_KEY (from your secrets escrow) is put into $ENV_FILE and hyfib-app is restarted, or"
    log "  (b) each failing channel's access token is re-entered (API only, there is no UI for this yet: PATCH /api/v1/channels/whatsapp/<id> with {\"accessToken\": ...}); it is re-encrypted under the current key."
    log "See docs/runbooks/dr-drill.md, \"DR-critical secrets\"."
    exit 3
    ;;
  *)
    log "ERROR: the configured CHANNEL_ENCRYPTION_KEY is unusable (see above); channel token encryption and decryption fail with it. Put the ORIGINAL key from your secrets escrow into $ENV_FILE (64 hex characters, or base64 of 32 bytes)."
    exit 3
    ;;
esac
```

Run: `chmod +x scripts/verify-channel-key.sh`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test scripts/test/verify-channel-key.test.mjs`
Expected: PASS — 10 tests, 0 fail. If the `padded` or quoted variants fail, print `read_key_from_env_file`'s output for that file and fix the sed/case logic (do not weaken the test). Also run each wrapper test under the system bash 3.2 (`/bin/bash` is already what `runScript` uses on macOS).

- [ ] **Step 7: Format the `.mjs` files and run the whole scripts suite**

Run: `pnpm exec prettier --write scripts/test/helpers.mjs scripts/test/verify-channel-key.test.mjs && pnpm exec prettier --check scripts/test/helpers.mjs scripts/test/verify-channel-key.test.mjs && node --test "scripts/test/*.test.mjs"`
Expected: Prettier clean; 28 tests pass (18 + 10), 0 fail.

- [ ] **Step 8: Commit (HOLD — only when the user asks)**

```bash
git add scripts/verify-channel-key.sh scripts/test/fake-bin scripts/test/helpers.mjs scripts/test/verify-channel-key.test.mjs
git commit -m "feat(scripts): verify-channel-key.sh wrapper with RLS guard and fake-psql tests"
```

---

## Task 3: `restore.sh` integration, its tests, and the live end-to-end run

**Files:**

- Modify: `scripts/restore.sh` (header comment; last line)
- Create: `scripts/test/restore-key-check.test.mjs`

**Interfaces:**

- Consumes: Task 2's `verify-channel-key.sh [db]` (exit `0`/`3`/`1`), `helpers.mjs` (`runScript`, `SCRIPTS_DIR`), the fake `psql`/`pg_restore`.
- Produces: `restore.sh` prints `restore: done` then exits with the wrapper's status.

- [ ] **Step 1: Write the failing integration tests**

Create `scripts/test/restore-key-check.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/test/restore-key-check.test.mjs`
Expected: FAIL — the wrong-key test gets status `0` (not `3`) and no `channel tokens decryptable` line, because `restore.sh` does not call the wrapper yet; the right-key test lacks the `decryptable: 1/1` line. The no-key test may already pass (it asserts current behaviour + a NOTE that doesn't exist yet → it fails on the NOTE match). Confirm failures are about the missing integration, not the fakes.

- [ ] **Step 3: Integrate the wrapper into `restore.sh`**

Edit `scripts/restore.sh`. Replace the last line

```bash
log "done"
```

with

```bash

# Channel access tokens are encrypted with CHANNEL_ENCRYPTION_KEY, which is deliberately NOT in the dump.
# A replacement VM generates a different key, so check now that the configured key can still decrypt what
# was just restored (exit 3 = database restored, environment not fully recovered).
verify_status=0
bash "$(dirname "${BASH_SOURCE[0]}")/verify-channel-key.sh" "$target" || verify_status=$?

log "done"
exit "$verify_status"
```

And in the header comment, replace

```bash
# Prints post-restore evidence (migration + tenant counts, RLS spot-check) for
# the DR-drill log.
```

with

```bash
# Prints post-restore evidence (migration + tenant counts, RLS spot-check) for
# the DR-drill log, then verifies that the configured CHANNEL_ENCRYPTION_KEY can
# decrypt the restored channel tokens (scripts/verify-channel-key.sh) and exits 3
# if it cannot. A missing key or a role that cannot read the tokens only prints a
# NOTE/WARNING and does not change the exit status.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/test/restore-key-check.test.mjs`
Expected: PASS — 3 tests, 0 fail.

- [ ] **Step 5: Format and run the whole scripts suite**

Run: `pnpm exec prettier --write scripts/test/restore-key-check.test.mjs && pnpm exec prettier --check scripts/test/restore-key-check.test.mjs && node --test "scripts/test/*.test.mjs"`
Expected: Prettier clean; 31 tests pass, 0 fail.

- [ ] **Step 6: Live end-to-end against a real Postgres (throwaway container, random port)**

Write `e2e-key-check.sh` to the session scratchpad (NOT into the repo):

```bash
#!/usr/bin/env bash
# Live end-to-end for restore-time channel-key verification. One throwaway postgres:15 container on a
# random localhost port (host psql/pg_dump are 15.x); nothing else on the machine is touched.
set -euo pipefail
cd "$REPO"
WORK="$(mktemp -d)"
NAME="hyfib-key-e2e-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" -e POSTGRES_USER=platform -e POSTGRES_PASSWORD=bootpw -e POSTGRES_DB=hyfib_wa \
  -p 127.0.0.1::5432 postgres:15-alpine >/dev/null
PORT="$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')"
export POSTGRES_HOST=127.0.0.1 POSTGRES_PORT="$PORT" POSTGRES_USER=platform POSTGRES_PASSWORD=bootpw POSTGRES_DB=hyfib_wa
export APP_DB_USER=hyfib_app APP_DB_PASSWORD=apppw
echo "throwaway postgres on 127.0.0.1:$PORT"

# The official image restarts once during init: wait for the SECOND "ready" line.
for _ in $(seq 1 90); do
  [ "$(docker logs "$NAME" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
pnpm migrate >"$WORK/migrate.log" 2>&1 || { tail -20 "$WORK/migrate.log"; exit 1; }

KEY_A="$(openssl rand -hex 32)"
KEY_B="$(openssl rand -hex 32)"
TOKEN="EAAB-e2e-plaintext-token"
ENC="$(K="$KEY_A" T="$TOKEN" node --input-type=module -e "import('./packages/shared-core/dist/index.js').then((m) => process.stdout.write(m.encryptSecret(process.env.T, process.env.K)))")"
PGPASSWORD=bootpw psql -h 127.0.0.1 -p "$PORT" -U platform -d hyfib_wa -v ON_ERROR_STOP=1 -v tok="$ENC" >/dev/null <<'SQL'
INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, display_phone_number, access_token_encrypted)
SELECT id, 'waba-e2e', 'pn-e2e-1', '+15550000001', :'tok' FROM tenants LIMIT 1;
SQL

BACKUP_DIR="$WORK/backups" bash scripts/backup.sh >"$WORK/backup.log" 2>&1
DUMP="$(ls -1t "$WORK"/backups/*.dump | head -1)"
echo "dump: $(basename "$DUMP")"

FAILS=0
ALL=""
expect() { # label expected-exit actual-exit
  if [ "$2" = "$3" ]; then echo "PASS  $1 (exit $3)"; else echo "FAIL  $1: expected exit $2, got $3"; FAILS=$((FAILS + 1)); fi
}
show() { printf '%s\n' "$1" | grep -E "verify-key:|restore: done|migrations applied|tenants:" | sed -E 's/^[0-9T:Z-]+ /    /' || true; }
run() { # label expected-exit env-assignments... -- command...
  local label="$1" want="$2"; shift 2
  set +e; out="$(env "$@" 2>&1)"; rc=$?; set -e
  ALL+="$out"$'\n'
  echo "### $label"; show "$out"; expect "$label" "$want" "$rc"
}

run "restore, right key (env)"      0 RESTORE_FORCE=1 CHANNEL_ENCRYPTION_KEY="$KEY_A" HYFIB_ENV_FILE=/nonexistent bash scripts/restore.sh "$DUMP"
run "restore, WRONG key (env)"      3 RESTORE_FORCE=1 CHANNEL_ENCRYPTION_KEY="$KEY_B" HYFIB_ENV_FILE=/nonexistent bash scripts/restore.sh "$DUMP"
echo "    DB still restored after exit 3: tenants=$(PGPASSWORD=bootpw psql -h 127.0.0.1 -p "$PORT" -U platform -d hyfib_wa -tAc 'select count(*) from tenants')"
run "restore, no key anywhere"      0 RESTORE_FORCE=1 HYFIB_ENV_FILE=/nonexistent bash scripts/restore.sh "$DUMP"

printf 'OTHER=1\nCHANNEL_ENCRYPTION_KEY="%s"\n' "$KEY_A" >"$WORK/hyfib.env"
run "restore, key from quoted env file" 0 RESTORE_FORCE=1 HYFIB_ENV_FILE="$WORK/hyfib.env" bash scripts/restore.sh "$DUMP"
printf 'CHANNEL_ENCRYPTION_KEY=%s\n' "$KEY_B" >"$WORK/hyfib-wrong.env"
run "restore, WRONG key from env file"  3 RESTORE_FORCE=1 HYFIB_ENV_FILE="$WORK/hyfib-wrong.env" bash scripts/restore.sh "$DUMP"

run "standalone wrapper, right key"  0 CHANNEL_ENCRYPTION_KEY="$KEY_A" HYFIB_ENV_FILE=/nonexistent bash scripts/verify-channel-key.sh
run "standalone wrapper, wrong key"  3 CHANNEL_ENCRYPTION_KEY="$KEY_B" HYFIB_ENV_FILE=/nonexistent bash scripts/verify-channel-key.sh

echo "### RLS guard: why it exists"
echo "    superuser sees:  $(PGPASSWORD=bootpw psql -h 127.0.0.1 -p "$PORT" -U platform -d hyfib_wa -tAc 'select count(*) from whatsapp_channels where access_token_encrypted is not null') token(s)"
echo "    hyfib_app sees:  $(PGPASSWORD=apppw psql -h 127.0.0.1 -p "$PORT" -U hyfib_app -d hyfib_wa -tAc 'select count(*) from whatsapp_channels where access_token_encrypted is not null') token(s)  <- silent zero"
run "wrapper as non-bypass role (hyfib_app)" 0 POSTGRES_USER=hyfib_app POSTGRES_PASSWORD=apppw CHANNEL_ENCRYPTION_KEY="$KEY_A" HYFIB_ENV_FILE=/nonexistent bash scripts/verify-channel-key.sh

echo "### leak check across ALL captured output"
for secret in "$KEY_A" "$KEY_B" "$TOKEN" "$ENC"; do
  if printf '%s' "$ALL" | grep -qF -- "$secret"; then echo "FAIL  leaked ${secret:0:8}…"; FAILS=$((FAILS + 1)); else echo "PASS  no ${secret:0:8}… in output"; fi
done

echo; [ "$FAILS" = 0 ] && echo "E2E RESULT: ALL PASS" || { echo "E2E RESULT: $FAILS FAILURE(S)"; exit 1; }
```

Run: `REPO="$PWD" bash /private/tmp/claude-501/-Users-manikandan-HyFib-WA-App--claude-worktrees-web-setup-310046/555b9155-b05d-416f-88bd-72b27939737a/scratchpad/e2e-key-check.sh`
Expected: `E2E RESULT: ALL PASS`, with these visible: right key → exit 0 and `decryptable: 1/1`; wrong key → exit 3, `0/1`, the ERROR block and `tenants=…` greater than zero (database still restored); no key → NOTE and exit 0; env-file variants as expected; the RLS demonstration shows superuser `1` vs hyfib_app `0` and the guard's `WARNING … subject to row-level security` with exit 0; no key/token/ciphertext in any output. The container and temp dir are removed on exit.

- [ ] **Step 7: Commit (HOLD — only when the user asks)**

```bash
git add scripts/restore.sh scripts/test/restore-key-check.test.mjs
git commit -m "feat(scripts): restore.sh verifies the channel-token key and exits 3 on mismatch"
```

---

## Task 4: Runbook and README

**Files:**

- Rewrite: `docs/runbooks/dr-drill.md`
- Modify: `deploy/oracle/README.md` (two table rows)

**Interfaces:**

- Consumes: the behaviour from Tasks 1–3 (`restore.sh` exit 3, `verify-channel-key.sh`, the `channel tokens decryptable: N/N` line).
- Produces: a runbook section anchor `#dr-critical-secrets` that the wrapper's ERROR text refers to.

- [ ] **Step 1: Replace `docs/runbooks/dr-drill.md` with the corrected runbook**

Write the whole file:

````markdown
# Runbook: Disaster Recovery Drill

Validate RPO/RTO objectives with evidence on a scheduled cadence (at least quarterly). This runbook
describes the current topology — the modular monolith on a single VM (`deploy/oracle/README.md`):
PostgreSQL, Redis, the app-server and Caddy.

## Objectives (set per environment)

- RPO: maximum acceptable data loss. **Today's implementation gives up to about 24 hours**: one dump per
  day at 02:30 UTC plus up to 15 minutes of timer jitter. A tighter RPO needs continuous WAL archiving
  (`pgBackRest`/`wal-g`) on top of the dumps.
- RTO: maximum acceptable downtime (e.g. ≤ 60 minutes).

## What is backed up

1. **PostgreSQL — implemented.** `scripts/backup.sh` produces a verified (`pg_restore --list`)
   custom-format dump with a sha256 checksum and prunes to `BACKUP_RETENTION` local copies (default 14).
   On the production VM the `hyfib-backup.timer` unit (installed by `deploy/oracle/setup-vm.sh`, daily
   02:30 UTC, `Persistent=true`) drives it with credentials from `/etc/hyfib/migrate.env`.
   **Shipping off the host is opt-in:** until `BACKUP_REMOTE_CMD` is set in `/etc/hyfib/backup.env`, the
   dumps exist only on the VM (the run logs a WARNING, yet the timer unit still reports success). A dump
   that never leaves the host is not DR. Once `BACKUP_REMOTE_CMD` is set, its failure fails the run.
   Restore with `scripts/restore.sh <dump>`: it verifies the checksum and integrity, refuses live or
   existing databases without `RESTORE_FORCE=1`, prints migration/tenant/RLS evidence, and verifies the
   channel-token key (see [DR-critical secrets](#dr-critical-secrets)). CI rehearses the cycle on every PR
   (`backup-restore-drill`: migrate → dump → drop → restore → run the persistence suite against the
   restored database). The docker-compose deployment has no backup timer — schedule `scripts/backup.sh`
   yourself there.
2. **Undelivered events.** In this topology there is no message broker (`EVENT_BUS=memory`). The
   transactional **outbox** is a PostgreSQL table, so events not yet delivered are part of the dump.
3. **Redis — not backed up, by design.** It holds only short-lived coordination state (rate-limit counters,
   replay/idempotency claims with expiry, out-of-office suppression). Sessions, the outbox and the campaign
   send log live in PostgreSQL. After a Redis loss the platform recovers on its own; at worst an event that
   was mid-redelivery is processed again.
4. **Secrets — not in the dump, and must not be.** See below.

## DR-critical secrets

A database dump alone does not recover the platform onto a new VM. These values live only in
`/etc/hyfib/hyfib.env` (root-only) and are in no backup:

| Secret | What it protects | If lost |
| --- | --- | --- |
| `CHANNEL_ENCRYPTION_KEY` | AES-256-GCM encryption of each WhatsApp channel's access token (`whatsapp_channels.access_token_encrypted`) — the only thing it encrypts | The restored tokens cannot be decrypted: outbound sends on those channels fail until each token is re-entered. No contact, message or campaign data is lost. |
| `META_APP_SECRET` | Verifying Meta webhook signatures | Re-copy it from the Meta app dashboard. |
| `WEBHOOK_VERIFY_TOKEN` | Meta's webhook subscription handshake | Use the value configured in the Meta webhook settings (or update Meta to the new one). |

Rules:

1. **Escrow `CHANNEL_ENCRYPTION_KEY`** in the organisation's secrets manager or password vault —
   **separately from `/var/backups/hyfib` and from wherever `BACKUP_REMOTE_CMD` ships dumps.** Never keep the
   key next to a dump: a leaked backup would then decrypt every channel token, which is exactly what the
   encryption is for.
2. `setup-vm.sh` writes `hyfib.env` only if it is missing and generates a **new random key**, so a
   replacement VM does not have the original one.
3. After restoring onto a replacement VM, put the original key into `/etc/hyfib/hyfib.env` (edit only that
   line) and run `sudo systemctl restart hyfib-app`. `restore.sh` — and `scripts/verify-channel-key.sh` on
   its own — reports whether the configured key decrypts the restored tokens: **exit status 3 means it
   does not.** A missing key or a role that cannot read the tokens only prints a NOTE/WARNING (tokens not
   verified) and leaves the status at 0.
4. If the key is truly lost, re-enter each channel's access token. This is **API-only** today: the
   onboarding page only creates a channel and Settings only lists them. You need an admin
   (`platform_owner` or `tenant_admin`) Bearer token:

   ```sh
   # 1. log in; the JSON reply contains "token"
   curl -sS -X POST https://<domain>/auth/login -H 'Content-Type: application/json' \
     -d '{"email":"<admin email>","password":"<admin password>"}'
   export TOKEN=<the token value from the reply>

   # 2. list the channels (ids), then re-enter the token for each failing one
   curl -sS -H "Authorization: Bearer $TOKEN" https://<domain>/api/v1/channels/whatsapp
   curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"accessToken":"<token from Meta>"}' https://<domain>/api/v1/channels/whatsapp/<channel-id>
   ```

   The token is re-encrypted under the current key. Issue a fresh token in Meta if the old value is
   unavailable.

## Drill procedure (single VM, `deploy/oracle`)

1. Provision a clean VM and deploy: `deploy/oracle/deploy.sh ubuntu@<ip> <domain>`. This generates NEW
   secrets in `/etc/hyfib/hyfib.env`.
2. Copy the latest dump (from the off-host location) to `/var/backups/hyfib/` on the VM.
3. Stop the app: `sudo systemctl stop hyfib-app`.
4. Restore:

   ```sh
   sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; RESTORE_FORCE=1 bash /opt/hyfib/app/scripts/restore.sh /var/backups/hyfib/<dump>"
   ```

   Expect the migration/tenant/RLS evidence and `channel tokens decryptable: N/N`. If it ends with an
   ERROR and exit status 3, the key on this VM is not the one that encrypted the tokens: put the escrowed
   `CHANNEL_ENCRYPTION_KEY` into `/etc/hyfib/hyfib.env` and re-check with:

   ```sh
   sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; bash /opt/hyfib/app/scripts/verify-channel-key.sh"
   ```

5. Start the app: `sudo systemctl start hyfib-app`, then check `https://<domain>/health`.
6. Log in with the restored users' credentials — the new VM's `/etc/hyfib/ADMIN_CREDENTIALS` only bootstraps
   an admin that does not exist yet. Confirm tenants, contacts and campaigns are present, a simulated
   webhook persists a message, and a test send through a channel is accepted. `scripts/local-runbook-e2e.sh`
   (written for the docker-compose stack) can serve as a broader smoke test.

## Evidence

Record start/end timestamps (RTO), the last restored transaction vs. incident time (RPO), the
`channel tokens decryptable: N/N` line, and attach the smoke-test output. File it in the compliance log.
````

- [ ] **Step 2: Verify every command and path the runbook cites actually exists**

Run:

```bash
for f in scripts/backup.sh scripts/restore.sh scripts/verify-channel-key.sh scripts/local-runbook-e2e.sh deploy/oracle/deploy.sh deploy/oracle/setup-vm.sh deploy/oracle/hyfib-backup.timer deploy/oracle/README.md; do test -f "$f" && echo "ok   $f" || echo "MISSING $f"; done
grep -nE "BACKUP_RETENTION:-14|OnCalendar=\*-\*-\* 02:30:00 UTC|RandomizedDelaySec=15m" scripts/backup.sh deploy/oracle/hyfib-backup.timer
grep -n "if \[ ! -f /etc/hyfib/hyfib.env \]" deploy/oracle/setup-vm.sh
```

Expected: every file `ok`; the grep lines confirm retention 14, the 02:30 UTC schedule with 15 minutes of jitter, and that `hyfib.env` is only written when missing.

- [ ] **Step 3: Add the two README pointers**

Edit `deploy/oracle/README.md`. Replace the row

```
| DB restore | `sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; RESTORE_FORCE=1 bash /opt/hyfib/app/scripts/restore.sh /var/backups/hyfib/<dump>"` (stop `hyfib-app` first) |
```

with

```
| DB restore | `sudo bash -c "set -a; . /etc/hyfib/migrate.env; set +a; RESTORE_FORCE=1 bash /opt/hyfib/app/scripts/restore.sh /var/backups/hyfib/<dump>"` (stop `hyfib-app` first). It then verifies the channel-token key and exits 3 if the configured key cannot decrypt the restored tokens — see [DR-critical secrets](../../docs/runbooks/dr-drill.md#dr-critical-secrets). |
```

and replace the row

```
| Secrets / env | `/etc/hyfib/hyfib.env` (root-only, chmod 600) |
```

with

```
| Secrets / env | `/etc/hyfib/hyfib.env` (root-only, chmod 600). **Escrow `CHANNEL_ENCRYPTION_KEY` outside the VM and outside the backups** — it is in no dump; see [DR-critical secrets](../../docs/runbooks/dr-drill.md#dr-critical-secrets). |
```

- [ ] **Step 4: Confirm the diff is docs-only and links resolve**

Run: `git diff --stat -- docs/runbooks/dr-drill.md deploy/oracle/README.md && test -f docs/runbooks/dr-drill.md && grep -n "^## DR-critical secrets" docs/runbooks/dr-drill.md`
Expected: only those two files changed; the `## DR-critical secrets` heading exists (so `#dr-critical-secrets` resolves).

- [ ] **Step 5: Commit (HOLD — only when the user asks)**

```bash
git add docs/runbooks/dr-drill.md deploy/oracle/README.md
git commit -m "docs(dr): DR-critical secrets, current-topology runbook, key check in the drill"
```

---

## Task 5: Final gate

**Files:** none.

- [ ] **Step 1: Run the full project gate**

Run: `pnpm build && pnpm lint && pnpm format:check && pnpm test`
Expected: build exit 0 with 0 TS errors; lint 0 errors (the same 2 pre-existing warnings); Prettier clean; `pnpm test` exit 0 — the workspace suites unchanged (571 node tests: 485 pass, 0 fail, 86 DB-gated skipped; 107 web-app) and the scripts suite adds 31 passing tests via the new root `test` script.

- [ ] **Step 2: Confirm the change set**

Run: `git status --short`
Expected: exactly — modified `package.json`, `scripts/restore.sh`, `docs/runbooks/dr-drill.md`, `deploy/oracle/README.md`; new `scripts/check-channel-key.mjs`, `scripts/verify-channel-key.sh`, `scripts/test/` (helpers, 3 test files, `fake-bin/psql`, `fake-bin/pg_restore`), and the spec and plan docs. `scripts/backup.sh` must be unchanged.

- [ ] **Step 3: Clean up and report**

Confirm no leftover container or temp files (`docker ps -a | grep hyfib-key-e2e` is empty), update the memory note for blocker 2, and report the results. Commits stay held until the user asks.
