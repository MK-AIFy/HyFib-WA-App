import test from "node:test";
import assert from "node:assert/strict";
import { decideDefaultAutomation } from "../dist/default-automations.js";

// 2026-07-29 is a Wednesday; 12:00 UTC.
const NOON = new Date("2026-07-29T12:00:00.000Z");
const OFFICE_HOURS = { wed: { open: "09:00", close: "17:00" } };
const CLOSED_NOW = { wed: { open: "13:00", close: "17:00" } };

function settings(overrides = {}) {
  return {
    timezone: "UTC",
    workingHours: {},
    welcomeEnabled: false,
    welcomeText: undefined,
    oooEnabled: false,
    oooText: undefined,
    ...overrides
  };
}

test("no settings row → no automation", () => {
  assert.equal(decideDefaultAutomation({ settings: undefined, firstInbound: true, now: NOON }), undefined);
});

test("nothing enabled → no automation", () => {
  assert.equal(decideDefaultAutomation({ settings: settings(), firstInbound: true, now: NOON }), undefined);
});

test("welcome fires on the first inbound only", () => {
  const s = settings({ welcomeEnabled: true, welcomeText: "  Hi there!  " });
  assert.deepEqual(decideDefaultAutomation({ settings: s, firstInbound: true, now: NOON }), {
    kind: "welcome",
    text: "Hi there!"
  });
  assert.equal(decideDefaultAutomation({ settings: s, firstInbound: false, now: NOON }), undefined);
});

test("ooo fires outside configured hours and wins over welcome", () => {
  const s = settings({
    workingHours: CLOSED_NOW,
    oooEnabled: true,
    oooText: "We are closed.",
    welcomeEnabled: true,
    welcomeText: "Hi!"
  });
  assert.deepEqual(decideDefaultAutomation({ settings: s, firstInbound: true, now: NOON }), {
    kind: "ooo",
    text: "We are closed."
  });
});

test("within hours the welcome fires, not ooo", () => {
  const s = settings({
    workingHours: OFFICE_HOURS,
    oooEnabled: true,
    oooText: "We are closed.",
    welcomeEnabled: true,
    welcomeText: "Hi!"
  });
  assert.deepEqual(decideDefaultAutomation({ settings: s, firstInbound: true, now: NOON }), {
    kind: "welcome",
    text: "Hi!"
  });
});

test("ooo never fires when working hours are unconfigured (empty map = feature unused)", () => {
  const s = settings({ oooEnabled: true, oooText: "Closed." });
  assert.equal(decideDefaultAutomation({ settings: s, firstInbound: false, now: NOON }), undefined);
});

test("blank texts disable their automation even when toggled on", () => {
  const s = settings({
    workingHours: CLOSED_NOW,
    oooEnabled: true,
    oooText: "   ",
    welcomeEnabled: true,
    welcomeText: ""
  });
  assert.equal(decideDefaultAutomation({ settings: s, firstInbound: true, now: NOON }), undefined);
});

test("ooo disabled → welcome still fires out of hours", () => {
  const s = settings({ workingHours: CLOSED_NOW, welcomeEnabled: true, welcomeText: "Hi!" });
  assert.deepEqual(decideDefaultAutomation({ settings: s, firstInbound: true, now: NOON }), {
    kind: "welcome",
    text: "Hi!"
  });
});
