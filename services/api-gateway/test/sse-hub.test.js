import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SSE_MAX_STREAM_AGE_MS, SseHub, formatSseFrame } from "../dist/sse-hub.js";

function fakeSink() {
  const sink = {
    chunks: [],
    ended: false,
    write(chunk) {
      sink.chunks.push(chunk);
      return true;
    },
    end() {
      sink.ended = true;
    }
  };
  return sink;
}

test("formatSseFrame produces the exact SSE framing", () => {
  const frame = formatSseFrame("whatsapp.inbound.received", "evt-1", { text: "hi" });
  assert.equal(frame, 'id: evt-1\nevent: whatsapp.inbound.received\ndata: {"text":"hi"}\n\n');
});

test("broadcast reaches only the matching tenant's clients", () => {
  const hub = new SseHub();
  const tenantA = fakeSink();
  const tenantB = fakeSink();
  hub.addClient("tenant-a", tenantA);
  hub.addClient("tenant-b", tenantB);

  const delivered = hub.broadcast("tenant-a", "whatsapp.inbound.received", "e1", { from: "+1" });

  assert.equal(delivered, 1);
  assert.equal(tenantA.chunks.length, 1);
  assert.match(tenantA.chunks[0], /whatsapp\.inbound\.received/);
  assert.equal(tenantB.chunks.length, 0);
});

test("removed clients no longer receive broadcasts", () => {
  const hub = new SseHub();
  const sink = fakeSink();
  const clientId = hub.addClient("tenant-a", sink);
  hub.removeClient("tenant-a", clientId);

  const delivered = hub.broadcast("tenant-a", "whatsapp.status.updated", "e2", {});

  assert.equal(delivered, 0);
  assert.equal(sink.chunks.length, 0);
  assert.equal(hub.hasClients(), false);
});

test("a client whose write throws is dropped, others still receive", () => {
  const hub = new SseHub();
  const broken = {
    write() {
      throw new Error("socket gone");
    },
    end() {}
  };
  const healthy = fakeSink();
  hub.addClient("tenant-a", broken);
  hub.addClient("tenant-a", healthy);

  const delivered = hub.broadcast("tenant-a", "whatsapp.inbound.received", "e3", {});

  assert.equal(delivered, 1);
  assert.equal(healthy.chunks.length, 1);
  // The broken client was evicted; the next broadcast only sees one client.
  assert.equal(hub.broadcast("tenant-a", "whatsapp.inbound.received", "e4", {}), 1);
});

test("pingAll writes a comment heartbeat to every client", () => {
  const hub = new SseHub();
  const one = fakeSink();
  const two = fakeSink();
  hub.addClient("tenant-a", one);
  hub.addClient("tenant-b", two);

  hub.pingAll();

  assert.equal(one.chunks[0], ": ping\n\n");
  assert.equal(two.chunks[0], ": ping\n\n");
});

test("close ends every client and clears state", () => {
  const hub = new SseHub();
  const sink = fakeSink();
  hub.addClient("tenant-a", sink);
  hub.startKeepAlive(60_000);

  hub.close();

  assert.equal(sink.ended, true);
  assert.equal(hub.hasClients(), false);
});

// ─── Ending a user's or a session's streams, and the lifetime cap ─────────────
// A stream is authorised once, at connect. Revoking the credential behind it (suspension, a password change, a
// logout) must end it too, and every stream ends after a bounded lifetime so a missed revocation (another gateway
// instance, a path that forgot to call the hub) cannot keep one open indefinitely. The web-app reconnects on its
// own, and a reconnect is authorised afresh.

test("closeUserStreams ends every stream of that user, in every tenant, and nobody else's", () => {
  const hub = new SseHub();
  const userTab1 = fakeSink();
  const userTab2 = fakeSink();
  const colleague = fakeSink();
  const anonymousClient = fakeSink();
  hub.addClient("tenant-a", userTab1, { userId: "user-1", sessionKey: "s1" });
  hub.addClient("tenant-a", userTab2, { userId: "user-1", sessionKey: "s2" });
  hub.addClient("tenant-a", colleague, { userId: "user-2", sessionKey: "s3" });
  hub.addClient("tenant-a", anonymousClient);

  assert.equal(hub.closeUserStreams("user-1"), 2);

  assert.equal(userTab1.ended, true);
  assert.equal(userTab2.ended, true);
  assert.equal(colleague.ended, false);
  assert.equal(anonymousClient.ended, false);
  // The ended streams are gone from the hub: tenant events reach only the two that are left.
  assert.equal(hub.broadcast("tenant-a", "whatsapp.inbound.received", "e5", { text: "secret" }), 2);
  assert.equal(userTab1.chunks.length, 0);
  assert.equal(colleague.chunks.length, 1);
  // Nothing left to close; a second call is a no-op.
  assert.equal(hub.closeUserStreams("user-1"), 0);
});

test("closeUserStreams matches the user id whatever its letter case", () => {
  const hub = new SseHub();
  const sink = fakeSink();
  hub.addClient("tenant-a", sink, { userId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" });
  assert.equal(hub.closeUserStreams("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), 1);
  assert.equal(sink.ended, true);
});

test("closeSessionStreams ends only the streams opened with that session", () => {
  const hub = new SseHub();
  const loggedOut = fakeSink();
  const otherDevice = fakeSink();
  hub.addClient("tenant-a", loggedOut, { userId: "user-1", sessionKey: "session-hash-1" });
  hub.addClient("tenant-a", otherDevice, { userId: "user-1", sessionKey: "session-hash-2" });

  assert.equal(hub.closeSessionStreams("session-hash-1"), 1);

  assert.equal(loggedOut.ended, true);
  assert.equal(otherDevice.ended, false);
  assert.equal(hub.broadcast("tenant-a", "whatsapp.status.updated", "e6", {}), 1);
});

test("a sink whose end() throws is still dropped", () => {
  const hub = new SseHub();
  hub.addClient(
    "tenant-a",
    {
      write: () => true,
      end() {
        throw new Error("socket gone");
      }
    },
    { userId: "user-1" }
  );
  assert.equal(hub.closeUserStreams("user-1"), 1);
  assert.equal(hub.hasClients(), false);
});

test("the keep-alive sweep ends a stream once it reaches the lifetime cap, and pings the younger ones", () => {
  let clock = 0;
  const hub = new SseHub({ maxStreamAgeMs: 1_000, now: () => clock });
  const old = fakeSink();
  hub.addClient("tenant-a", old, { userId: "user-1" });
  clock = 500;
  const young = fakeSink();
  hub.addClient("tenant-a", young, { userId: "user-2" });

  clock = 999;
  hub.pingAll();
  assert.equal(old.ended, false, "just under the cap: still open");
  assert.deepEqual(old.chunks, [": ping\n\n"]);

  clock = 1_000;
  hub.pingAll();
  assert.equal(old.ended, true, "at the cap: ended");
  assert.equal(old.chunks.length, 1, "an expired stream is not pinged again");
  assert.equal(young.ended, false);
  assert.equal(young.chunks.length, 2);
  assert.equal(hub.broadcast("tenant-a", "whatsapp.inbound.received", "e7", {}), 1, "only the young stream is left");
});

test("streams are capped at ten minutes unless the hub is told otherwise", () => {
  assert.equal(DEFAULT_SSE_MAX_STREAM_AGE_MS, 10 * 60_000);
  let clock = 0;
  const hub = new SseHub({ now: () => clock });
  const sink = fakeSink();
  hub.addClient("tenant-a", sink);

  clock = DEFAULT_SSE_MAX_STREAM_AGE_MS - 1;
  hub.pingAll();
  assert.equal(sink.ended, false);

  clock = DEFAULT_SSE_MAX_STREAM_AGE_MS;
  hub.pingAll();
  assert.equal(sink.ended, true);
  assert.equal(hub.hasClients(), false);
});

test("the keep-alive sweep reports how many streams the lifetime cap ended, and stays quiet when none", () => {
  let now = 0;
  const reported = [];
  const hub = new SseHub({ maxStreamAgeMs: 1_000, now: () => now, onExpired: (count) => reported.push(count) });
  hub.addClient("t-1", fakeSink(), { userId: "u-1" });
  hub.addClient("t-2", fakeSink(), { userId: "u-2" });

  now = 500;
  hub.pingAll();
  assert.deepEqual(reported, [], "nothing expired, nothing reported");

  now = 1_000;
  hub.pingAll();
  assert.deepEqual(reported, [2], "both streams reached the cap and the count is reported once");
  assert.equal(hub.hasClients(), false);
});
