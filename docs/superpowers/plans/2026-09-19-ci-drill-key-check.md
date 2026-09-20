# CI Drill: Channel-Key Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every PR, prove against a real Postgres backup → destroy → restore cycle that the restore-time channel-token key check works: the right key passes, and the wrong key fails.

**Architecture:** Only the `backup-restore-drill` job in `.github/workflows/ci.yml` changes. The job's existing test key moves to job level so `restore.sh` verifies it by itself; one channel token encrypted with that key is seeded before the backup; two new steps assert that the standalone check reports `1/1` with the right key (proving it verified something, not that it silently skipped) and exits exactly `3` with a wrong key. A scratch harness runs the job's real shell steps, extracted from the YAML, against a throwaway `postgres:15` so the gate can be shown to fail when it should.

**Tech Stack:** GitHub Actions YAML, bash, Ruby (system Psych) for the scratch harness and structural assertions, Docker for the throwaway Postgres.

**Parent:** `docs/superpowers/specs/2026-09-19-restore-key-check-design.md` (listed there as a follow-up: "a CI drill step against a real database").

## Global Constraints

- One module: `.github/workflows/ci.yml` only. The harness and assertion scripts live in the session scratchpad, not the repo. Runbook wording ("CI rehearses …") is a docs follow-up, not part of this iteration.
- The job's existing steps keep their commands: `Apply all migrations`, `Backup`, `Destroy the database (simulated disaster)`, and the restore command `bash scripts/restore.sh "$(ls -1t "$BACKUP_DIR"/*.dump | head -1)"` are unchanged.
- The test key value stays exactly `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` (test-only; the same value the persistence suite already uses). The wrong key is `fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210`.
- Steps run under GitHub's default `bash -e {0}` (no pipefail): write them so `-e` semantics are correct. `cmd || status=$?` is the idiom for capturing an expected non-zero exit.
- The new steps use only what the job already has: psql client (installed earlier in the job), built `packages/shared-core/dist`, and the job env `POSTGRES_*`.
- CI uses `postgres:16-alpine`; the local harness uses `postgres:15-alpine` because the host's `psql`/`pg_dump` are 15.x (a 15 client cannot dump a newer server). Nothing in these steps is version-specific.
- Prettier (`.prettierrc.json`) checks YAML: run `pnpm exec prettier --check .github/workflows/ci.yml`.
- Never touch other projects' Docker containers or fixed ports; the harness uses one throwaway container on a random localhost port and removes it on exit.
- **Commits: hold** until the user asks (standing rule).

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `.github/workflows/ci.yml` | modify (`backup-restore-drill` job) | Job-level key; seed step; two key-check steps; drop the now-duplicate step-level key |
| scratchpad `run-drill.rb` | create (not committed) | Runs the job's shell steps from the YAML against a throwaway Postgres, with `--skip` / `--env` mutation flags |
| scratchpad `check-ci-drill.rb` | create (not committed) | Structural assertions on the parsed workflow |

---

## Task 1: The local drill harness, and proof of the gap (RED)

**Files:**

- Create: `<scratchpad>/run-drill.rb` (scratchpad: `/private/tmp/claude-501/-Users-manikandan-HyFib-WA-App--claude-worktrees-web-setup-310046/555b9155-b05d-416f-88bd-72b27939737a/scratchpad/`)

**Interfaces:**

- Produces: `ruby run-drill.rb [--skip "<step name>"]... [--env "<step name>:KEY=VALUE"]...` — runs, in order, every `run:` step of the `backup-restore-drill` job except install/build steps, with the job env (host/port/backup-dir overridden for the local container) merged with the step's own env and any `--env` override. Stops at the first failing step. Prints `DRILL RESULT: PASS` or `DRILL RESULT: FAIL at step '<name>'` and exits 0/1.

- [ ] **Step 1: Write the harness**

Create `run-drill.rb` in the scratchpad:

```ruby
#!/usr/bin/env ruby
# Runs the backup-restore-drill job's shell steps from .github/workflows/ci.yml locally, against a
# throwaway postgres:15 container on a random localhost port. Steps are extracted from the YAML —
# never retyped — so what runs here is what CI runs. Install/build steps are skipped (done locally).
#
#   ruby run-drill.rb [--skip "Step name"]... [--env "Step name:KEY=VALUE"]...
require "yaml"
require "open3"
require "tmpdir"
require "fileutils"

WORKFLOW = ".github/workflows/ci.yml"
JOB = "backup-restore-drill"
NOT_RUN_LOCALLY = /\A(corepack enable|pnpm install|pnpm build)/

skips = []
overrides = Hash.new { |hash, key| hash[key] = {} }
args = ARGV.dup
until args.empty?
  case args.shift
  when "--skip"
    skips << args.shift
  when "--env"
    step, assignment = args.shift.split(":", 2)
    key, value = assignment.split("=", 2)
    overrides[step][key] = value
  else
    abort "unknown argument"
  end
end

job = YAML.load_file(WORKFLOW).fetch("jobs").fetch(JOB)
container = "hyfib-drill-#{Process.pid}"
work = Dir.mktmpdir("drill-")
at_exit do
  system("docker", "rm", "-f", container, out: File::NULL, err: File::NULL)
  FileUtils.rm_rf(work)
end

system("docker", "run", "-d", "--rm", "--name", container, "-e", "POSTGRES_USER=platform",
       "-e", "POSTGRES_PASSWORD=bootpw", "-e", "POSTGRES_DB=hyfib_wa", "-p", "127.0.0.1::5432",
       "postgres:15-alpine", out: File::NULL) || abort("cannot start postgres")
port = `docker port #{container} 5432/tcp`.lines.first.strip.split(":").last
# The official image restarts once during init: wait for the SECOND "ready" line.
90.times do
  break if `docker logs #{container} 2>&1`.scan("ready to accept connections").size >= 2
  sleep 1
end
puts "throwaway postgres:15 on 127.0.0.1:#{port}"

base_env = { "PATH" => ENV["PATH"], "HOME" => ENV["HOME"] }
job_env = (job["env"] || {}).transform_values(&:to_s).merge(
  "POSTGRES_HOST" => "127.0.0.1", "POSTGRES_PORT" => port, "PGPORT" => port,
  "BACKUP_DIR" => File.join(work, "backups")
)

result = "PASS"
failed_step = nil
job.fetch("steps").each do |step|
  run = step["run"]
  next unless run

  label = step["name"] || run.lines.first.strip
  next if label == "Install psql client" || run =~ NOT_RUN_LOCALLY

  puts "### #{label}"
  if skips.include?(label)
    puts "    (skipped by request)"
    next
  end

  env = base_env.merge(job_env).merge((step["env"] || {}).transform_values(&:to_s)).merge(overrides[label])
  script = File.join(work, "step.sh")
  File.write(script, run)
  output, status = Open3.capture2e(env, "bash", "-e", script, unsetenv_others: true)

  interesting = output.lines.grep(/decryptable|exited|ERROR|WARNING|NOTE|^ℹ (tests|pass|fail)|Tests /)
  puts interesting.map { |line| "    #{line}" }.join unless interesting.empty?
  if status.success?
    puts "    exit 0"
  else
    puts "    exit #{status.exitstatus}"
    puts output.lines.last(20).map { |line| "    | #{line}" }.join
    result = "FAIL"
    failed_step = label
    break
  end
end

puts
puts "DRILL RESULT: #{result}#{failed_step ? " at step '#{failed_step}'" : ""}"
exit(result == "PASS" ? 0 : 1)
```

- [ ] **Step 2: Baseline — the UNCHANGED workflow passes end to end**

Run (from the repo root): `ruby <scratchpad>/run-drill.rb`
Expected: steps `Apply all migrations`, `Backup`, `Destroy the database (simulated disaster)`, `Restore from the dump`, `Persistence suite against the RESTORED database` all `exit 0`; the persistence suite prints its `tests`/`pass`/`fail` summary with `fail 0`; final line `DRILL RESULT: PASS`. This validates the harness itself against today's CI behaviour. The restore step prints the `NOTE … channel tokens NOT verified` line (no key in the job env).

- [ ] **Step 3: RED — show the gap: a wrong key at restore goes unnoticed today**

Run: `ruby <scratchpad>/run-drill.rb --env "Restore from the dump:CHANNEL_ENCRYPTION_KEY=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"`
Expected: `DRILL RESULT: PASS` — the job is green even though the key is wrong, because no channel token is seeded, so the restore step finds `nothing to verify`. This is the gap the change closes; record it as the failing baseline.

---

## Task 2: Change the workflow (GREEN) and prove the gate

**Files:**

- Modify: `.github/workflows/ci.yml` (`backup-restore-drill` job only)
- Create: `<scratchpad>/check-ci-drill.rb`

**Interfaces:**

- Consumes: Task 1's `run-drill.rb` flags; `scripts/restore.sh` and `scripts/verify-channel-key.sh` (exit `0`/`3`, line `channel tokens decryptable: N/N`); `packages/shared-core/dist` (`encryptSecret`).
- Produces: workflow steps named exactly `Seed a channel token encrypted with the test key`, `Key check passes with the right key`, `Key check exits 3 with the wrong key`.

- [ ] **Step 1: Write the structural assertions, and watch them fail**

Create `check-ci-drill.rb` in the scratchpad:

```ruby
require "yaml"

KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
WRONG = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
SEED = "Seed a channel token encrypted with the test key"
RIGHT = "Key check passes with the right key"
NEGATIVE = "Key check exits 3 with the wrong key"

job = YAML.load_file(".github/workflows/ci.yml")["jobs"]["backup-restore-drill"]
steps = job["steps"]
names = steps.map { |s| s["name"] }
at = ->(name) { names.index(name) }
find = ->(name) { steps.find { |s| s["name"] == name } || {} }

checks = {
  "job env carries the test key" => (job["env"] || {})["CHANNEL_ENCRYPTION_KEY"] == KEY,
  "seed step exists" => !at.(SEED).nil?,
  "seed runs after migrations and before the backup" =>
    !at.(SEED).nil? && at.(SEED) > at.("Apply all migrations") && at.(SEED) < at.("Backup"),
  "seed encrypts with the app's encryptSecret and inserts via psql" =>
    find.(SEED)["run"].to_s.include?("encryptSecret") && find.(SEED)["run"].to_s.include?("whatsapp_channels"),
  "restore command is unchanged" =>
    find.("Restore from the dump")["run"].to_s.strip == 'bash scripts/restore.sh "$(ls -1t "$BACKUP_DIR"/*.dump | head -1)"',
  "right-key check exists, after the restore" =>
    !at.(RIGHT).nil? && at.(RIGHT) > at.("Restore from the dump"),
  "right-key check asserts 'decryptable: 1/1' (proves it verified, not skipped)" =>
    find.(RIGHT)["run"].to_s.include?("channel tokens decryptable: 1/1"),
  "wrong-key check exists, after the right-key check" =>
    !at.(NEGATIVE).nil? && at.(NEGATIVE) > at.(RIGHT),
  "wrong-key check overrides the key with the wrong one" =>
    (find.(NEGATIVE)["env"] || {})["CHANNEL_ENCRYPTION_KEY"] == WRONG,
  "wrong-key check requires exit status exactly 3" =>
    find.(NEGATIVE)["run"].to_s.include?('test "$status" -eq 3'),
  "both key checks run before the persistence suite" =>
    !at.(NEGATIVE).nil? && at.(NEGATIVE) < at.("Persistence suite against the RESTORED database"),
  "persistence step no longer carries its own duplicate key" =>
    !(find.("Persistence suite against the RESTORED database")["env"] || {}).key?("CHANNEL_ENCRYPTION_KEY")
}

checks.each { |label, ok| puts "#{ok ? 'PASS' : 'FAIL'}  #{label}" }
exit(checks.values.all? ? 0 : 1)
```

Run: `ruby <scratchpad>/check-ci-drill.rb`
Expected: FAIL — `restore command is unchanged` passes and the rest fail (nothing has been added yet). Confirm the failures are the missing steps, not a script error.

- [ ] **Step 2: Apply the workflow edits**

Edit 1 — hoist the key to job level. In `.github/workflows/ci.yml`, replace

```yaml
      POSTGRES_PASSWORD: bootpw
      BACKUP_DIR: /tmp/hyfib-backups
    steps:
```

with

```yaml
      POSTGRES_PASSWORD: bootpw
      BACKUP_DIR: /tmp/hyfib-backups
      # Test-only key. restore.sh and verify-channel-key.sh read it from the environment, so the drill
      # also proves the restored channel tokens still decrypt; the persistence suite reuses it too.
      CHANNEL_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    steps:
```

Edit 2 — seed a token before the backup. Replace

```yaml
        run: pnpm migrate
      - name: Backup
        run: bash scripts/backup.sh
```

with

```yaml
        run: pnpm migrate
      # One channel token encrypted with the test key, so the restore-time key check has something real to
      # decrypt (an empty table would report "nothing to verify" and pass for ANY key).
      - name: Seed a channel token encrypted with the test key
        run: |
          ENC="$(node --input-type=module -e "import('file://' + process.cwd() + '/packages/shared-core/dist/index.js').then((m) => process.stdout.write(m.encryptSecret('drill-channel-token', process.env.CHANNEL_ENCRYPTION_KEY)))")"
          PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v tok="$ENC" <<'SQL'
          INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, display_phone_number, access_token_encrypted)
          SELECT id, 'waba-drill', 'pn-drill-1', '+15550000001', :'tok' FROM tenants LIMIT 1;
          SQL
      - name: Backup
        run: bash scripts/backup.sh
```

Edit 3 — verify after the restore, and drop the duplicate key. Replace

```yaml
        run: bash scripts/restore.sh "$(ls -1t "$BACKUP_DIR"/*.dump | head -1)"
      - name: Persistence suite against the RESTORED database
        env:
          NODE_ENV: test
          RUN_DB_TESTS: "1"
          POSTGRES_APP_USER: hyfib_app
          POSTGRES_APP_PASSWORD: apppw
          CHANNEL_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        run: pnpm --filter @hyfib/persistence test
```

with

```yaml
        run: bash scripts/restore.sh "$(ls -1t "$BACKUP_DIR"/*.dump | head -1)"
      # restore.sh above already verifies the key (exit 3 on mismatch). This step additionally proves the
      # check RAN and verified the seeded token — a silent skip would print a NOTE/WARNING and exit 0.
      - name: Key check passes with the right key
        run: |
          out="$(bash scripts/verify-channel-key.sh)"
          echo "$out"
          echo "$out" | grep -q 'channel tokens decryptable: 1/1'
      # ...and the negative case: a wrong key must be detected, with exactly exit status 3.
      - name: Key check exits 3 with the wrong key
        env:
          CHANNEL_ENCRYPTION_KEY: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
        run: |
          status=0
          bash scripts/verify-channel-key.sh || status=$?
          echo "verify-channel-key.sh exited $status"
          test "$status" -eq 3
      - name: Persistence suite against the RESTORED database
        env:
          NODE_ENV: test
          RUN_DB_TESTS: "1"
          POSTGRES_APP_USER: hyfib_app
          POSTGRES_APP_PASSWORD: apppw
        run: pnpm --filter @hyfib/persistence test
```

- [ ] **Step 3: Run the structural assertions — they pass**

Run: `ruby <scratchpad>/check-ci-drill.rb`
Expected: 12 lines, all `PASS`; exit 0.

- [ ] **Step 4: Prettier**

Run: `pnpm exec prettier --check .github/workflows/ci.yml`
Expected: `All matched files use Prettier code style!` — if it reports the file, run `pnpm exec prettier --write .github/workflows/ci.yml`, inspect `git diff` to confirm the change is cosmetic, and re-run Step 3.

- [ ] **Step 5: GREEN — the full job passes locally, including the new steps**

Run: `ruby <scratchpad>/run-drill.rb`
Expected: every step `exit 0`, in this order — `Apply all migrations`, `Seed a channel token encrypted with the test key`, `Backup`, `Destroy the database (simulated disaster)`, `Restore from the dump` (shows `channel tokens decryptable: 1/1`), `Key check passes with the right key` (shows `1/1`), `Key check exits 3 with the wrong key` (shows `verify-channel-key.sh exited 3`), `Persistence suite against the RESTORED database` (`fail 0`); final `DRILL RESULT: PASS`. If the persistence suite fails only because the seeded channel changes an expectation, seed into a dedicated tenant instead and re-run; if it fails once for an unrelated transient reason (see the memory note about a one-off persistence flake), re-run once.

- [ ] **Step 6: Prove the gate — each mutation must FAIL the job at the right step**

Run each and check the failing step:

1. Wrong key at restore (the exact scenario that stayed green in Task 1 Step 3):
   `ruby <scratchpad>/run-drill.rb --env "Restore from the dump:CHANNEL_ENCRYPTION_KEY=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"`
   Expected: `DRILL RESULT: FAIL at step 'Restore from the dump'`, the step showing `exit 3` and `decryptable: 0/1`.
2. No token seeded (a check that silently verifies nothing):
   `ruby <scratchpad>/run-drill.rb --skip "Seed a channel token encrypted with the test key"`
   Expected: `DRILL RESULT: FAIL at step 'Key check passes with the right key'` (the output says `nothing to verify`, so the `1/1` grep fails).
3. A negative check that would pass if the checker always said OK (right key supplied to the wrong-key step):
   `ruby <scratchpad>/run-drill.rb --env "Key check exits 3 with the wrong key:CHANNEL_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"`
   Expected: `DRILL RESULT: FAIL at step 'Key check exits 3 with the wrong key'` (`exited 0`, so `test 0 -eq 3` fails).

- [ ] **Step 7: Commit (HOLD — only when the user asks)**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(drill): seed a channel token and assert the restore-time key check passes and fails correctly"
```

---

## Task 3: Final checks

**Files:** none.

- [ ] **Step 1: Repo-level gate on the changed state**

Run: `pnpm format:check && git status --short && git diff --stat`
Expected: Prettier clean; the only change is `.github/workflows/ci.yml` (the scratchpad scripts are outside the repo). Application code is untouched, so build/lint/test results are unchanged from the last gate (0 failures).

- [ ] **Step 2: Confirm nothing is left behind**

Run: `docker ps -a --format '{{.Names}}' | grep '^hyfib-drill' || echo none`
Expected: `none` — the harness removes its container on exit.

- [ ] **Step 3: Report and update memory**

Report the RED → GREEN evidence (the gap in Task 1 Step 3 and the three mutation failures), note that the first real proof is the next CI run after a push, and flag the follow-up to update the runbook's "CI rehearses the cycle …" sentence. Update the readiness-audit memory note. Commits stay held until the user asks.
