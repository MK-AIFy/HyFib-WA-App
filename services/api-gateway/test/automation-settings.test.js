import test from "node:test";
import assert from "node:assert/strict";
import { validateAutomationSettingsPatch } from "../dist/automation-settings.js";

test("a full valid patch passes with trimmed texts", () => {
  const result = validateAutomationSettingsPatch({
    timezone: "Asia/Kolkata",
    workingHours: { mon: { open: "09:00", close: "18:00" }, sun: null },
    welcomeEnabled: true,
    welcomeText: "  Welcome!  ",
    oooEnabled: true,
    oooText: "We are away.",
    oooSuppressHours: 6
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.welcomeText, "Welcome!");
  assert.deepEqual(result.value.workingHours, { mon: { open: "09:00", close: "18:00" }, sun: null });
});

test("unknown IANA timezone is rejected", () => {
  const result = validateAutomationSettingsPatch({ timezone: "Mars/OlympusMons" });
  assert.equal(result.ok, false);
  assert.match(result.error, /timezone/);
});

test("working hours are validated structurally", () => {
  assert.equal(validateAutomationSettingsPatch({ workingHours: { funday: null } }).ok, false);
  assert.equal(validateAutomationSettingsPatch({ workingHours: { mon: { open: "9", close: "17:00" } } }).ok, false);
});

test("texts: null clears, empty string rejected, 1024 cap", () => {
  assert.equal(validateAutomationSettingsPatch({ welcomeText: null }).ok, true);
  assert.equal(validateAutomationSettingsPatch({ welcomeText: "   " }).ok, false);
  assert.equal(validateAutomationSettingsPatch({ oooText: "x".repeat(1025) }).ok, false);
});

test("suppress hours bounds and boolean type checks", () => {
  assert.equal(validateAutomationSettingsPatch({ oooSuppressHours: 0 }).ok, false);
  assert.equal(validateAutomationSettingsPatch({ oooSuppressHours: 169 }).ok, false);
  assert.equal(validateAutomationSettingsPatch({ oooSuppressHours: 2.5 }).ok, false);
  assert.equal(validateAutomationSettingsPatch({ welcomeEnabled: "yes" }).ok, false);
});

test("empty or non-object bodies are rejected", () => {
  assert.equal(validateAutomationSettingsPatch({}).ok, false);
  assert.equal(validateAutomationSettingsPatch(null).ok, false);
  assert.equal(validateAutomationSettingsPatch([1]).ok, false);
});
