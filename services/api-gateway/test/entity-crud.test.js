import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAutoReplyRulePatch,
  validateAutomationRulePatch,
  validateSegmentPatch,
  validateContactPatch,
  validateChannelPatch,
  validateUserPatch
} from "../dist/entity-crud.js";

const KEYWORD_RULE = { matchType: "keyword", keyword: "hi" };

// ─── auto-reply rule patch ──────────────────────────────────────────────────

test("auto-reply patch: partial field update passes and clamps priority", () => {
  const result = validateAutoReplyRulePatch({ replyText: "  Hello  ", priority: 5000 }, KEYWORD_RULE);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { replyText: "Hello", priority: 1000 });
});

test("auto-reply patch: switching to matchType any clears the keyword", () => {
  const result = validateAutoReplyRulePatch({ matchType: "any" }, KEYWORD_RULE);
  assert.equal(result.ok, true);
  assert.equal(result.value.keyword, null);
});

test("auto-reply patch: switching to regex validates the EXISTING keyword when none is supplied", () => {
  const bad = validateAutoReplyRulePatch({ matchType: "regex" }, { matchType: "keyword", keyword: "([" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /regular expression/);

  const good = validateAutoReplyRulePatch({ matchType: "regex" }, { matchType: "keyword", keyword: "^h(i|ello)$" });
  assert.equal(good.ok, true);
});

test("auto-reply patch: clearing keyword while match type still needs one is rejected", () => {
  const result = validateAutoReplyRulePatch({ keyword: "" }, KEYWORD_RULE);
  assert.equal(result.ok, false);
});

test("auto-reply patch: empty body is rejected", () => {
  const result = validateAutoReplyRulePatch({}, KEYWORD_RULE);
  assert.equal(result.ok, false);
  assert.match(result.error, /at least one/);
});

// ─── automation rule patch ──────────────────────────────────────────────────

const TAG_RULE = { actionType: "add_tag", actionConfig: { tag: "vip" } };

test("automation patch: field updates pass; unknown trigger rejected", () => {
  const ok = validateAutomationRulePatch({ name: "Renamed", priority: 2 }, TAG_RULE);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { name: "Renamed", priority: 2 });

  const bad = validateAutomationRulePatch({ triggerType: "on_moon_phase" }, TAG_RULE);
  assert.equal(bad.ok, false);
});

test("automation patch: switching to assign_agent requires an assignee in the merged config", () => {
  const missing = validateAutomationRulePatch({ actionType: "assign_agent" }, TAG_RULE);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /assigneeUserId/);

  const provided = validateAutomationRulePatch(
    { actionType: "assign_agent", actionConfig: { assigneeUserId: "11111111-1111-1111-1111-111111111111" } },
    TAG_RULE
  );
  assert.equal(provided.ok, true);
});

test("automation patch: existing assign_agent rule keeps satisfying the rule via existing config", () => {
  const existing = {
    actionType: "assign_agent",
    actionConfig: { assigneeUserId: "11111111-1111-1111-1111-111111111111" }
  };
  const result = validateAutomationRulePatch({ name: "Reassign" }, existing);
  assert.equal(result.ok, true);
});

// ─── segment / contact / channel / user patches ─────────────────────────────

test("segment patch: name/definition validated; empty rejected", () => {
  assert.equal(validateSegmentPatch({ name: "VIPs" }).ok, true);
  assert.equal(validateSegmentPatch({ definition: { country: "IN" } }).ok, true);
  assert.equal(validateSegmentPatch({ definition: [] }).ok, false);
  assert.equal(validateSegmentPatch({}).ok, false);
});

test("contact patch: null clears, strings bounded, country cannot be null", () => {
  const ok = validateContactPatch({ firstName: " Asha ", lastName: null, timezone: "Asia/Kolkata" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { firstName: "Asha", lastName: null, timezone: "Asia/Kolkata" });

  assert.equal(validateContactPatch({ country: null }).ok, false);
  assert.equal(validateContactPatch({ firstName: "x".repeat(101) }).ok, false);
  assert.equal(validateContactPatch({}).ok, false);
});

test("channel patch: display number, isActive, token rotate/clear", () => {
  const ok = validateChannelPatch({ displayPhoneNumber: "+15550001111", isActive: false, accessToken: "tok" });
  assert.equal(ok.ok, true);

  const clear = validateChannelPatch({ accessToken: null });
  assert.equal(clear.ok, true);
  assert.equal(clear.value.accessToken, null);

  assert.equal(validateChannelPatch({ isActive: "yes" }).ok, false);
  assert.equal(validateChannelPatch({ accessToken: "" }).ok, false);
  assert.equal(validateChannelPatch({}).ok, false);
});

test("user patch: status enum + roles allowlist + dedupe", () => {
  const valid = new Set(["tenant_admin", "analyst", "support_agent"]);
  const ok = validateUserPatch({ status: "suspended", roles: ["analyst", "analyst"] }, valid);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { status: "suspended", roles: ["analyst"] });

  assert.equal(validateUserPatch({ status: "zombie" }, valid).ok, false);
  assert.equal(validateUserPatch({ roles: [] }, valid).ok, false);
  assert.equal(validateUserPatch({ roles: ["root"] }, valid).ok, false);
  assert.equal(validateUserPatch({}, valid).ok, false);
});

test("user patch: keepApiKeys is a boolean, accepted only with a status that takes the user out", () => {
  const valid = new Set(["tenant_admin", "analyst"]);
  for (const status of ["suspended", "disabled", "invited"]) {
    for (const keepApiKeys of [true, false]) {
      const ok = validateUserPatch({ status, keepApiKeys }, valid);
      assert.equal(ok.ok, true, `${status} with keepApiKeys ${keepApiKeys}`);
      assert.deepEqual(ok.value, { status, keepApiKeys });
    }
  }
  // Absent stays absent, so a patch without it keeps exactly the shape it had.
  assert.deepEqual(validateUserPatch({ status: "suspended" }, valid).value, { status: "suspended" });

  for (const keepApiKeys of ["true", 1, 0, null, {}, []]) {
    const refused = validateUserPatch({ status: "suspended", keepApiKeys }, valid);
    assert.equal(refused.ok, false, `keepApiKeys ${JSON.stringify(keepApiKeys)} is refused`);
    assert.equal(refused.error, "keepApiKeys must be a boolean");
  }

  // keepApiKeys: true is rejected, not ignored, where it would do nothing: reactivating never restores a revoked
  // key, and a patch that keeps the user's status never touches its keys.
  for (const patch of [
    { status: "active", keepApiKeys: true },
    { roles: ["analyst"], keepApiKeys: true }
  ]) {
    const refused = validateUserPatch(patch, valid);
    assert.equal(refused.ok, false, `${JSON.stringify(patch)} is refused`);
    assert.match(refused.error, /^keepApiKeys applies only when status is one of: invited, suspended, disabled/);
  }
  // keepApiKeys: false asks for nothing (it is the default), so it is accepted everywhere as a no-op and not copied
  // into the value — a client that always sends the boolean (e.g. a checkbox) must not get a 400 on reactivation.
  assert.deepEqual(validateUserPatch({ status: "active", keepApiKeys: false }, valid).value, { status: "active" });
  assert.deepEqual(validateUserPatch({ roles: ["analyst"], keepApiKeys: false }, valid).value, { roles: ["analyst"] });
  assert.equal(validateUserPatch({ keepApiKeys: true }, valid).error, "at least one of status or roles is required");
});
