import test from "node:test";
import assert from "node:assert/strict";
import { SseHub, formatSseFrame } from "../dist/sse-hub.js";

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
