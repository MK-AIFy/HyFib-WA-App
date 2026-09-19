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
