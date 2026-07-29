import test from "node:test";
import assert from "node:assert/strict";
import { validateFlowDefinition, advanceFlow } from "../dist/flows.js";

const SUPPORT_FLOW = {
  start: "greet",
  nodes: {
    greet: { type: "message", text: "Hi! How can we help?", next: "ask" },
    ask: {
      type: "question",
      text: "Reply 1 for orders, 2 for support.",
      branches: [
        { match: "1", next: "orders" },
        { match: "2", next: "handoff" }
      ],
      fallbackNext: "ask_again"
    },
    ask_again: { type: "message", text: "Sorry, I didn't get that.", next: "ask" },
    orders: { type: "message", text: "Your order info is on its way.", next: "tag_orders" },
    tag_orders: { type: "add_tag", tag: "orders-bot", next: "done" },
    handoff: { type: "assign_team", teamId: "11111111-1111-1111-1111-111111111111", next: "done" },
    done: { type: "end" }
  }
};

// ─── validateFlowDefinition ─────────────────────────────────────────────────

test("a well-formed flow validates", () => {
  assert.equal(validateFlowDefinition(SUPPORT_FLOW).ok, true);
});

test("start and every next/branch target must exist", () => {
  assert.equal(validateFlowDefinition({ start: "missing", nodes: SUPPORT_FLOW.nodes }).ok, false);
  const dangling = structuredClone(SUPPORT_FLOW);
  dangling.nodes.greet.next = "nowhere";
  assert.equal(validateFlowDefinition(dangling).ok, false);
  const badBranch = structuredClone(SUPPORT_FLOW);
  badBranch.nodes.ask.branches[0].next = "nowhere";
  assert.equal(validateFlowDefinition(badBranch).ok, false);
});

test("shape errors are rejected: node caps, texts, unknown types, empty branches", () => {
  assert.equal(validateFlowDefinition(null).ok, false);
  assert.equal(validateFlowDefinition({ start: "a", nodes: {} }).ok, false);
  assert.equal(validateFlowDefinition({ start: "a", nodes: { a: { type: "teleport" } } }).ok, false);
  assert.equal(validateFlowDefinition({ start: "a", nodes: { a: { type: "message", text: "" } } }).ok, false);
  assert.equal(
    validateFlowDefinition({ start: "a", nodes: { a: { type: "question", text: "?", branches: [] } } }).ok,
    false
  );
  const tooMany = { start: "n0", nodes: {} };
  for (let i = 0; i < 51; i += 1) tooMany.nodes[`n${i}`] = { type: "message", text: "x", next: `n${i + 1}` };
  tooMany.nodes.n51 = { type: "end" };
  assert.equal(validateFlowDefinition(tooMany).ok, false);
});

// ─── advanceFlow ────────────────────────────────────────────────────────────

test("starting runs through message nodes and waits at the first question", () => {
  const result = advanceFlow(SUPPORT_FLOW, SUPPORT_FLOW.start, null);
  assert.deepEqual(
    result.actions.map((a) => a.type),
    ["send", "send"]
  );
  assert.equal(result.actions[0].text, "Hi! How can we help?");
  assert.equal(result.actions[1].text, "Reply 1 for orders, 2 for support.");
  assert.deepEqual(result.outcome, { status: "waiting", node: "ask" });
});

test("a matching reply follows its branch and executes side-effect nodes to the end", () => {
  const result = advanceFlow(SUPPORT_FLOW, "ask", "1");
  assert.deepEqual(
    result.actions.map((a) => a.type),
    ["send", "add_tag"]
  );
  assert.equal(result.actions[1].tag, "orders-bot");
  assert.deepEqual(result.outcome, { status: "done" });
});

test("branch matching is case-insensitive and trims; fallback re-asks on no match", () => {
  const upper = advanceFlow(
    {
      start: "q",
      nodes: { q: { type: "question", text: "yes?", branches: [{ match: "YES", next: "e" }] }, e: { type: "end" } }
    },
    "q",
    "  yes  "
  );
  assert.deepEqual(upper.outcome, { status: "done" });

  const fallback = advanceFlow(SUPPORT_FLOW, "ask", "banana");
  assert.equal(fallback.actions[0].text, "Sorry, I didn't get that.");
  assert.deepEqual(fallback.outcome, { status: "waiting", node: "ask" });
});

test("a question with no fallback stays waiting silently on an unmatched reply", () => {
  const flow = {
    start: "q",
    nodes: { q: { type: "question", text: "pick", branches: [{ match: "a", next: "e" }] }, e: { type: "end" } }
  };
  const result = advanceFlow(flow, "q", "zzz");
  assert.equal(result.actions.length, 0);
  assert.deepEqual(result.outcome, { status: "waiting", node: "q" });
});

test("assign_team emits its action and the step cap breaks message loops", () => {
  const handoff = advanceFlow(SUPPORT_FLOW, "ask", "2");
  assert.deepEqual(
    handoff.actions.map((a) => a.type),
    ["assign_team"]
  );
  assert.deepEqual(handoff.outcome, { status: "done" });

  const loop = {
    start: "a",
    nodes: {
      a: { type: "message", text: "ping", next: "b" },
      b: { type: "message", text: "pong", next: "a" }
    }
  };
  const result = advanceFlow(loop, "a", null);
  assert.ok(result.actions.length <= 10, "step cap bounds runaway loops");
  assert.deepEqual(result.outcome, { status: "done" });
});
