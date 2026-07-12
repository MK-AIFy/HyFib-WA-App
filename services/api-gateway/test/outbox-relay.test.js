import test from "node:test";
import assert from "node:assert/strict";
import { runOutboxRelayOnce } from "../dist/outbox-relay.js";

function row(overrides = {}) {
  return {
    id: "row-1",
    tenant_id: "tenant-1",
    topic: "whatsapp.outbound.requested",
    payload: { foo: "bar" },
    status: "pending",
    created_at: new Date(),
    attempts: 0,
    next_attempt_at: new Date(),
    last_error: null,
    ...overrides
  };
}

function fakeLogger() {
  const warn = [];
  const error = [];
  return {
    warn: (message, metadata) => warn.push({ message, metadata }),
    error: (message, metadata) => error.push({ message, metadata }),
    warn_calls: warn,
    error_calls: error
  };
}

function fakeCounters() {
  const published = [];
  const failed = [];
  const dead = [];
  return {
    published: (topic) => published.push(topic),
    failed: (topic) => failed.push(topic),
    dead: (topic) => dead.push(topic),
    published_calls: published,
    failed_calls: failed,
    dead_calls: dead
  };
}

test("happy path: every row is published and marked processed, none marked failed", async () => {
  const rows = [row({ id: "a" }), row({ id: "b" })];
  const published = [];
  const markedProcessed = [];
  const markedFailed = [];
  const counters = fakeCounters();
  const logger = fakeLogger();

  await runOutboxRelayOnce({
    claim: async () => rows,
    publish: async (topic, payload, tenantId) => {
      published.push({ topic, payload, tenantId });
    },
    markProcessed: async (id) => {
      markedProcessed.push(id);
    },
    markFailed: async (id, error) => {
      markedFailed.push({ id, error });
    },
    counters,
    logger
  });

  assert.deepEqual(published.map((p) => p.topic), ["whatsapp.outbound.requested", "whatsapp.outbound.requested"]);
  assert.deepEqual(markedProcessed, ["a", "b"]);
  assert.deepEqual(markedFailed, []);
  assert.deepEqual(counters.published_calls, ["whatsapp.outbound.requested", "whatsapp.outbound.requested"]);
  assert.deepEqual(counters.failed_calls, []);
  assert.deepEqual(counters.dead_calls, []);
});

test("poison row: a publish failure only marks that row failed and lets siblings process, in order", async () => {
  const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
  const published = [];
  const markedProcessed = [];
  const markedFailed = [];

  await runOutboxRelayOnce({
    claim: async () => rows,
    publish: async (topic, payload, tenantId) => {
      published.push(payload);
      if (payload === rows[1].payload) {
        throw new Error("boom");
      }
    },
    markProcessed: async (id) => {
      markedProcessed.push(id);
    },
    markFailed: async (id, error) => {
      markedFailed.push({ id, error });
    },
    logger: fakeLogger()
  });

  assert.deepEqual(markedProcessed, ["a", "c"]);
  assert.deepEqual(markedFailed, [{ id: "b", error: "boom" }]);
  // Rows are still attempted (and thus published-called) in original order.
  assert.deepEqual(published, [rows[0].payload, rows[1].payload, rows[2].payload]);
});

test("dead transition: a row at attempts=7 (max 8) takes the dead counter/log path", async () => {
  const rows = [row({ id: "poison", attempts: 7 })];
  const counters = fakeCounters();
  const logger = fakeLogger();

  await runOutboxRelayOnce({
    claim: async () => rows,
    publish: async () => {
      throw new Error("still broken");
    },
    markProcessed: async () => {},
    markFailed: async () => {},
    counters,
    logger
  });

  assert.deepEqual(counters.failed_calls, ["whatsapp.outbound.requested"]);
  assert.deepEqual(counters.dead_calls, ["whatsapp.outbound.requested"]);
  assert.equal(logger.warn_calls.length, 0);
  assert.equal(logger.error_calls.length, 1);
  assert.equal(logger.error_calls[0].message, "outbox_row_dead");
  assert.equal(logger.error_calls[0].metadata.attempts, 8);
  assert.equal(logger.error_calls[0].metadata.id, "poison");
});

test("markFailed throwing does not prevent processing of subsequent rows", async () => {
  const rows = [row({ id: "a" }), row({ id: "b" })];
  const markedProcessed = [];
  const logger = fakeLogger();

  await runOutboxRelayOnce({
    claim: async () => rows,
    publish: async (topic, payload) => {
      if (payload === rows[0].payload) {
        throw new Error("publish failed");
      }
    },
    markProcessed: async (id) => {
      markedProcessed.push(id);
    },
    markFailed: async () => {
      throw new Error("db is down");
    },
    logger
  });

  // Row "b" (not the poison row) still gets published + marked processed.
  assert.deepEqual(markedProcessed, ["b"]);
  // The markFailed failure itself was logged rather than thrown.
  assert.ok(logger.error_calls.some((c) => c.message === "outbox_mark_failed_error"));
});

test("claim() throwing resolves without an unhandled rejection", async () => {
  const logger = fakeLogger();

  await assert.doesNotReject(
    runOutboxRelayOnce({
      claim: async () => {
        throw new Error("connection refused");
      },
      publish: async () => {},
      markProcessed: async () => {},
      markFailed: async () => {},
      logger
    })
  );

  assert.equal(logger.error_calls.length, 1);
  assert.equal(logger.error_calls[0].message, "outbox_relay_error");
  assert.equal(logger.error_calls[0].metadata.error, "connection refused");
});
