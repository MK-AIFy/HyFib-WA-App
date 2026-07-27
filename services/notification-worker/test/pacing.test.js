import test from "node:test";
import assert from "node:assert/strict";
import { dispatchScheduleAt, continuationScheduleAt, isFinalBatch, BATCH_SIZE } from "../dist/pacing.js";

/**
 * Campaign pacing used to be implemented as sleeping: acquireRateLimit blocked
 * once per recipient inside the fan-out loop. Because the in-memory bus awaits
 * its handler and the outbox relay holds a re-entrancy guard, that blocked the
 * relay — and therefore every outbound message platform-wide — for the entire
 * run: roughly 2.8 hours for 10k recipients at the default 60/min.
 *
 * These functions replace that with scheduling. Nothing sleeps; rows carry the
 * time they should go out and the relay's existing next_attempt_at filter does
 * the pacing.
 */

const START = Date.UTC(2026, 0, 1, 12, 0, 0);

test("dispatchScheduleAt spreads a batch evenly across its window", () => {
  const first = dispatchScheduleAt(START, 0, 60).getTime();
  const second = dispatchScheduleAt(START, 1, 60).getTime();
  const tenth = dispatchScheduleAt(START, 9, 60).getTime();

  assert.equal(first, START, "the first send goes out immediately");
  assert.equal(second - first, 1_000, "60/min is one send per second");
  assert.equal(tenth - first, 9_000);
});

test("dispatchScheduleAt honours the configured rate", () => {
  // 30/min is one send every two seconds.
  assert.equal(dispatchScheduleAt(START, 1, 30).getTime() - START, 2_000);
  // 600/min is ten per second.
  assert.equal(dispatchScheduleAt(START, 10, 600).getTime() - START, 1_000);
});

test("dispatchScheduleAt never schedules into the past and tolerates a nonsense rate", () => {
  // A zero or negative rate must not divide by zero or produce Infinity — a row
  // scheduled at an invalid timestamp would never become claimable, silently
  // stranding the whole campaign.
  for (const rate of [0, -5, Number.NaN]) {
    const at = dispatchScheduleAt(START, 5, rate).getTime();
    assert.ok(Number.isFinite(at), `rate ${rate} must still produce a real timestamp`);
    assert.ok(at >= START, `rate ${rate} must not schedule into the past`);
  }
});

test("continuationScheduleAt lands after the batch it follows", () => {
  const lastSend = dispatchScheduleAt(START, BATCH_SIZE - 1, 60).getTime();
  const continuation = continuationScheduleAt(START, 60).getTime();

  assert.ok(
    continuation >= lastSend,
    "re-entering before the current batch has been delivered would claim work faster than it sends"
  );
});

test("isFinalBatch is true only when the claim came back short", () => {
  // A full batch means more recipients may remain, so the run must continue.
  assert.equal(isFinalBatch(BATCH_SIZE), false);
  assert.equal(isFinalBatch(BATCH_SIZE - 1), true);
  assert.equal(isFinalBatch(0), true);
});
