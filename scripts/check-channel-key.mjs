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
    rows.push(
      tab === -1 ? { id: `line ${index + 1}`, payload: "" } : { id: line.slice(0, tab), payload: line.slice(tab + 1) }
    );
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
