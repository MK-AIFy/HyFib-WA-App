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
