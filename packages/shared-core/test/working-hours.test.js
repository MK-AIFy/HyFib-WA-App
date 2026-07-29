import test from "node:test";
import assert from "node:assert/strict";
import { isWithinWorkingHours, validateWorkingHours } from "../dist/working-hours.js";

// 2026-07-29 is a Wednesday. 12:00 UTC = 17:30 IST (Asia/Kolkata).
const WED_NOON_UTC = new Date("2026-07-29T12:00:00.000Z");

test("unconfigured hours (empty object) are always open", () => {
  assert.equal(isWithinWorkingHours({}, "UTC", WED_NOON_UTC), true);
});

test("within the configured window on the right weekday", () => {
  const hours = { wed: { open: "09:00", close: "18:00" } };
  assert.equal(isWithinWorkingHours(hours, "UTC", WED_NOON_UTC), true);
});

test("outside the window on a configured day", () => {
  const hours = { wed: { open: "13:00", close: "18:00" } };
  assert.equal(isWithinWorkingHours(hours, "UTC", WED_NOON_UTC), false);
});

test("a day missing from the config is closed all day", () => {
  const hours = { mon: { open: "09:00", close: "18:00" } };
  assert.equal(isWithinWorkingHours(hours, "UTC", WED_NOON_UTC), false);
});

test("an explicitly null day is closed", () => {
  const hours = { wed: null, thu: { open: "09:00", close: "18:00" } };
  assert.equal(isWithinWorkingHours(hours, "UTC", WED_NOON_UTC), false);
});

test("timezone is honoured — 12:00 UTC is 17:30 in Asia/Kolkata", () => {
  const hours = { wed: { open: "09:00", close: "17:00" } };
  assert.equal(isWithinWorkingHours(hours, "UTC", WED_NOON_UTC), true);
  assert.equal(isWithinWorkingHours(hours, "Asia/Kolkata", WED_NOON_UTC), false, "17:30 IST is past 17:00 close");
});

test("open boundary is inclusive, close boundary exclusive", () => {
  const hours = { wed: { open: "12:00", close: "18:00" } };
  assert.equal(isWithinWorkingHours(hours, "UTC", WED_NOON_UTC), true);
  const atClose = { wed: { open: "06:00", close: "12:00" } };
  assert.equal(isWithinWorkingHours(atClose, "UTC", WED_NOON_UTC), false);
});

test("overnight windows (close < open) span midnight", () => {
  const nightShift = { wed: { open: "20:00", close: "04:00" } };
  assert.equal(isWithinWorkingHours(nightShift, "UTC", WED_NOON_UTC), false);
  assert.equal(isWithinWorkingHours(nightShift, "UTC", new Date("2026-07-29T22:00:00.000Z")), true);
  // 02:00 Wednesday falls inside TUESDAY's overnight window, not Wednesday's.
  const tueNight = { tue: { open: "20:00", close: "04:00" } };
  assert.equal(isWithinWorkingHours(tueNight, "UTC", new Date("2026-07-29T02:00:00.000Z")), true);
});

test("an invalid timezone fails OPEN (never blocks replies) ", () => {
  const hours = { wed: { open: "13:00", close: "18:00" } };
  assert.equal(isWithinWorkingHours(hours, "Not/AZone", WED_NOON_UTC), true);
});

// ─── validateWorkingHours ───────────────────────────────────────────────────

test("validateWorkingHours accepts a well-formed weekly config", () => {
  const result = validateWorkingHours({ mon: { open: "09:00", close: "18:00" }, sat: null });
  assert.equal(result.ok, true);
});

test("validateWorkingHours rejects unknown days, bad times, and non-objects", () => {
  assert.equal(validateWorkingHours({ funday: { open: "09:00", close: "18:00" } }).ok, false);
  assert.equal(validateWorkingHours({ mon: { open: "9am", close: "18:00" } }).ok, false);
  assert.equal(validateWorkingHours({ mon: { open: "09:00", close: "25:00" } }).ok, false);
  assert.equal(validateWorkingHours({ mon: { open: "09:00" } }).ok, false);
  assert.equal(validateWorkingHours({ mon: { open: "09:00", close: "09:00" } }).ok, false, "zero-length window");
  assert.equal(validateWorkingHours([]).ok, false);
  assert.equal(validateWorkingHours("mon").ok, false);
});
