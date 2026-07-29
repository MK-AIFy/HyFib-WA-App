import test from "node:test";
import assert from "node:assert/strict";
import { dispatchAi } from "../dist/index.js";

test("dispatchAi lead-score returns a deterministic 0-100 score", async () => {
  const raw = JSON.stringify({ recencyDays: 5, engagementScore: 80, purchaseCount: 3, averageOrderValue: 5000 });
  const res = await dispatchAi("lead-score", "POST", raw, "req-1");
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.score, "number");
  assert.ok(res.body.score >= 0 && res.body.score <= 100);
  assert.equal(res.body.scale, "0-100");
});

test("dispatchAi lead-score rejects out-of-range inputs with 400", async () => {
  const raw = JSON.stringify({ recencyDays: -1, engagementScore: 80, purchaseCount: 3, averageOrderValue: 5000 });
  const res = await dispatchAi("lead-score", "POST", raw, "req-2");
  assert.equal(res.status, 400);
});

test("dispatchAi rejects non-POST with 405", async () => {
  const res = await dispatchAi("lead-score", "GET", undefined, "req-3");
  assert.equal(res.status, 405);
});

test("dispatchAi returns 404 for an unknown ai path", async () => {
  const res = await dispatchAi("does-not-exist", "POST", "{}", "req-4");
  assert.equal(res.status, 404);
});

// ─── Inbox copilot (G15) ────────────────────────────────────────────────────

test("conversation-summary validates the transcript shape", async () => {
  const { dispatchAi } = await import("../dist/index.js");
  for (const bad of [{}, { messages: [] }, { messages: [{ direction: "sideways", text: "x" }] }]) {
    const res = await dispatchAi("conversation-summary", "POST", JSON.stringify(bad), "req-cs1");
    assert.equal(res.status, 400);
  }
});

test("conversation-summary falls back deterministically without an Anthropic key", async () => {
  const { dispatchAi } = await import("../dist/index.js");
  const res = await dispatchAi(
    "conversation-summary",
    "POST",
    JSON.stringify({
      messages: [
        { direction: "inbound", text: "My order 123 has not arrived" },
        { direction: "outbound", text: "Let me check" },
        { direction: "inbound", text: "It was due yesterday" }
      ]
    }),
    "req-cs2"
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "fallback");
  assert.match(res.body.summary, /2 from the customer/);
  assert.match(res.body.summary, /due yesterday/);
});

test("suggest-reply returns up to three bounded suggestions in fallback mode", async () => {
  const { dispatchAi } = await import("../dist/index.js");
  const res = await dispatchAi(
    "suggest-reply",
    "POST",
    JSON.stringify({ messages: [{ direction: "inbound", text: "Can you help me?" }] }),
    "req-sr1"
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "fallback");
  assert.equal(res.body.suggestions.length, 3);
  for (const s of res.body.suggestions) {
    assert.ok(typeof s === "string" && s.length > 0 && s.length <= 300);
  }
});

test("parseSuggestions handles numbered, bulleted and unstructured output", async () => {
  const { parseSuggestions } = await import("../dist/index.js");
  assert.deepEqual(parseSuggestions("1. Alpha\n2) Beta\n- Gamma\n4. Delta"), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(parseSuggestions("Just one plain line"), ["Just one plain line"]);
});

test("copilot transcripts omit textless rows and cap sizes", async () => {
  const { normalizeCopilotMessages } = await import("../dist/index.js");
  const normalized = normalizeCopilotMessages([
    { direction: "inbound", text: "  hello  " },
    { direction: "outbound", text: "" },
    { direction: "inbound", text: "x".repeat(5000) }
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].text, "hello");
  assert.equal(normalized[1].text.length, 1000);
  assert.equal(normalizeCopilotMessages([{ direction: "inbound", text: "   " }]), undefined);
});
