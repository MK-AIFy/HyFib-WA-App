/**
 * Campaign send pacing, expressed as scheduling rather than sleeping.
 *
 * The fan-out loop used to call acquireRateLimit once per approved recipient,
 * which sleeps until a token-bucket slot frees up. Because InMemoryEventBus
 * awaits its handlers and the outbox relay holds a re-entrancy guard for the
 * duration of a tick, that sleep blocked the relay — and with it every outbound
 * message platform-wide, not just campaigns — for the whole run. At the default
 * 60/min a 10,000-recipient campaign wedged the relay for roughly 2.8 hours.
 *
 * Instead, each dispatch row is stamped with the time it should go out and the
 * relay's existing `next_attempt_at <= now()` filter (015_outbox_durability.sql)
 * does the pacing for free. Nothing blocks: the fan-out enqueues and returns.
 *
 * These functions are pure so they are unit-testable, following the same
 * convention as click-tracking.ts and campaign.ts in the gateway.
 */

/** Recipients claimed per fan-out invocation. */
export const BATCH_SIZE = 50;

/** Sends per minute assumed when a campaign does not configure one. */
const DEFAULT_RATE_PER_MINUTE = 60;

/**
 * Milliseconds between consecutive sends at `ratePerMinute`.
 *
 * A zero, negative, or non-finite rate falls back to the default rather than
 * producing Infinity or NaN. That matters: a row stamped with an invalid
 * timestamp would never satisfy `next_attempt_at <= now()`, so it would never
 * be claimed and the campaign would stall silently with no error anywhere.
 */
function intervalMs(ratePerMinute: number): number {
  const rate = Number.isFinite(ratePerMinute) && ratePerMinute > 0 ? ratePerMinute : DEFAULT_RATE_PER_MINUTE;
  return 60_000 / rate;
}

/**
 * When the `index`-th send of a batch should go out, counting from `startMs`.
 * Index 0 goes immediately, so a batch is spread across its window instead of
 * arriving all at once.
 */
export function dispatchScheduleAt(startMs: number, index: number, ratePerMinute: number): Date {
  return new Date(startMs + index * intervalMs(ratePerMinute));
}

/**
 * When the next fan-out invocation should run.
 *
 * Deliberately one whole batch-window ahead: re-entering sooner would claim and
 * schedule recipients faster than the previous batch is being delivered, piling
 * up outbox rows and defeating the pacing the schedule exists to enforce.
 */
export function continuationScheduleAt(startMs: number, ratePerMinute: number): Date {
  return new Date(startMs + BATCH_SIZE * intervalMs(ratePerMinute));
}

/**
 * True when a claim came back short, meaning no recipients remain and the run
 * should not re-enter. A full batch always warrants a continuation, even if the
 * next claim turns out to be empty — one wasted invocation is far cheaper than
 * abandoning a campaign mid-run.
 */
export function isFinalBatch(claimedCount: number): boolean {
  return claimedCount < BATCH_SIZE;
}
