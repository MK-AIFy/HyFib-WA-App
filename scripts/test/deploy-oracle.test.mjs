import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * deploy/oracle/deploy.sh runs its second half on the VM, over ssh, which cannot run here. These tests pin the
 * order of what that half does, because the order is the safety property: check the new build's config before
 * touching the database, back up before migrating (scripts/migrate.sh --backup-first, tested in migrate.test.mjs),
 * and record the deploy only once the new build is healthy, so the deploy log's last line is what is running.
 */

const DEPLOY = fileURLToPath(new URL("../../deploy/oracle/deploy.sh", import.meta.url));
const source = readFileSync(DEPLOY, "utf8");
const remote = source.slice(source.indexOf("<<'REMOTE'"), source.lastIndexOf("\nREMOTE\n"));

/** Where `pattern` first appears in the remote half. */
function at(pattern) {
  const index = remote.search(pattern);
  assert.notEqual(index, -1, `the remote half of deploy.sh contains ${pattern}`);
  return index;
}

test("deploy.sh is valid bash", () => {
  const r = spawnSync("bash", ["-n", DEPLOY], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("the new build's config is checked before the database is touched", () => {
  assert.ok(at(/loadConfig\(\)/) < at(/scripts\/migrate\.sh/));
});

test("migrations run with --backup-first, under the daily backup timer's settings", () => {
  assert.match(remote, /scripts\/migrate\.sh' --backup-first/);
  assert.match(remote, /BACKUP_DIR=\/var\/backups\/hyfib/);
  assert.match(remote, /\/etc\/hyfib\/backup\.env/);
});

test("the deploy is recorded only after the new build passed the health gate", () => {
  assert.ok(at(/systemctl restart hyfib-app/) < at(/deploys\.log/));
  assert.ok(at(/did not become healthy/) < at(/deploys\.log/));
});

test("the local half sends the VM the commit being deployed, flagging uncommitted changes", () => {
  assert.match(source, /git -C "\$ROOT" rev-parse HEAD/);
  assert.match(source, /\+uncommitted/);
  assert.match(source, /bash -s -- "\$DOMAIN" "\$ACME_EMAIL" "\$VERSION"/);
});
