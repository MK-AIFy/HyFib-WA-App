import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAutomationRules, matchesConditions, planAction } from "../dist/automation.js";

const rule = (over) => ({
  id: "r1",
  tenantId: "t1",
  name: "rule",
  triggerType: "new_message",
  conditions: {},
  actionType: "add_tag",
  actionConfig: { tag: "vip" },
  enabled: true,
  priority: 0,
  createdAt: "2026-01-01T00:00:00Z",
  ...over
});

test("matchesConditions enforces keyword on new_message", () => {
  const r = rule({ conditions: { keyword: "refund" } });
  assert.equal(matchesConditions(r, { messageText: "I want a REFUND please" }), true);
  assert.equal(matchesConditions(r, { messageText: "hello" }), false);
});

test("matchesConditions enforces tag on tag_added", () => {
  const r = rule({ triggerType: "tag_added", conditions: { tag: "lead" } });
  assert.equal(matchesConditions(r, { addedTag: "lead" }), true);
  assert.equal(matchesConditions(r, { addedTag: "other" }), false);
});

test("planAction maps each action type and drops misconfigured ones", () => {
  assert.deepEqual(planAction(rule()), { kind: "add_tag", tag: "vip" });
  assert.deepEqual(planAction(rule({ actionType: "add_tag", actionConfig: {} })), undefined);
  assert.deepEqual(
    planAction(rule({ actionType: "send_template", actionConfig: { templateName: "welcome" } })),
    { kind: "send_template", templateName: "welcome", templateLanguage: "en_US" }
  );
  assert.deepEqual(planAction(rule({ actionType: "create_task", actionConfig: {} })), {
    kind: "create_task",
    title: "Follow up",
    dueInMinutes: undefined
  });
});

test("evaluateAutomationRules returns matched actions and skips disabled/non-matching", () => {
  const rules = [
    rule({ id: "a", actionType: "add_tag", actionConfig: { tag: "vip" } }),
    rule({ id: "b", enabled: false, actionType: "add_tag", actionConfig: { tag: "skip" } }),
    rule({ id: "c", conditions: { keyword: "buy" }, actionType: "create_task", actionConfig: { taskTitle: "Call" } }),
    rule({ id: "d", triggerType: "tag_added", actionType: "add_tag", actionConfig: { tag: "wrong-trigger" } })
  ];
  const actions = evaluateAutomationRules("new_message", { messageText: "i want to buy" }, rules);
  assert.deepEqual(actions, [
    { kind: "add_tag", tag: "vip" },
    { kind: "create_task", title: "Call", dueInMinutes: undefined }
  ]);
});
