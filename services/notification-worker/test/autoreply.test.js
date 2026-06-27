import test from "node:test";
import assert from "node:assert/strict";
import { matchAutoReply } from "../dist/autoreply.js";

const makeRule = (overrides) => ({
  id: "r1",
  tenantId: "t1",
  matchType: "keyword",
  keyword: null,
  replyKind: "text",
  replyText: "Hello",
  enabled: true,
  priority: 0,
  createdAt: new Date().toISOString(),
  ...overrides
});

test("returns undefined for empty text", () => {
  assert.equal(matchAutoReply(undefined, [makeRule({ matchType: "any" })]), undefined);
});

test("returns undefined for empty rules", () => {
  assert.equal(matchAutoReply("hello", []), undefined);
});

test("keyword match (exact, case-insensitive)", () => {
  const rule = makeRule({ matchType: "keyword", keyword: "HELLO" });
  assert.equal(matchAutoReply("hello", [rule]), rule);
  assert.equal(matchAutoReply("hello world", [rule]), undefined);
});

test("contains match", () => {
  const rule = makeRule({ matchType: "contains", keyword: "promo" });
  assert.equal(matchAutoReply("Tell me about the promo today", [rule]), rule);
  assert.equal(matchAutoReply("nothing here", [rule]), undefined);
});

test("regex match", () => {
  const rule = makeRule({ matchType: "regex", keyword: "^order\\s+\\d+" });
  assert.equal(matchAutoReply("order 12345", [rule]), rule);
  assert.equal(matchAutoReply("cancel order 12345", [rule]), undefined);
});

test("any match fires on any text", () => {
  const rule = makeRule({ matchType: "any" });
  assert.equal(matchAutoReply("whatever", [rule]), rule);
});

test("disabled rule is skipped", () => {
  const disabled = makeRule({ matchType: "any", enabled: false });
  const enabled = makeRule({ id: "r2", matchType: "keyword", keyword: "hi" });
  assert.equal(matchAutoReply("hi", [disabled, enabled]), enabled);
});

test("invalid regex rule is skipped without throwing", () => {
  const bad = makeRule({ matchType: "regex", keyword: "[invalid" });
  assert.equal(matchAutoReply("anything", [bad]), undefined);
});

test("priority ordering: first rule in array wins", () => {
  const r1 = makeRule({ id: "r1", matchType: "any", replyText: "First" });
  const r2 = makeRule({ id: "r2", matchType: "any", replyText: "Second" });
  assert.equal(matchAutoReply("test", [r1, r2]), r1);
});
