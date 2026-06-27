import test from "node:test";
import assert from "node:assert/strict";
import { resolveVariables } from "../dist/personalize.js";

const contact = {
  firstName: "Alice",
  lastName: "Smith",
  phoneE164: "+15551230000",
  country: "US",
  tags: ["vip", "loyal"],
  timezone: "America/New_York"
};

test("maps contact field names to positional params", () => {
  const result = resolveVariables({ 1: "firstName", 2: "lastName" }, contact);
  assert.deepEqual(result, ["Alice", "Smith"]);
});

test("resolves literal values", () => {
  const result = resolveVariables({ 1: "firstName", 2: { literal: "20% off" } }, contact);
  assert.deepEqual(result, ["Alice", "20% off"]);
});

test("falls back to empty string for missing field", () => {
  const result = resolveVariables({ 1: "nonexistent" }, contact);
  assert.deepEqual(result, [""]);
});

test("returns empty array for undefined mapping", () => {
  assert.deepEqual(resolveVariables(undefined, contact), []);
});

test("returns empty array for empty mapping", () => {
  assert.deepEqual(resolveVariables({}, contact), []);
});

test("fills gaps with empty strings for non-contiguous keys", () => {
  const result = resolveVariables({ 1: "firstName", 3: "country" }, contact);
  assert.deepEqual(result, ["Alice", "", "US"]);
});

test("resolves phone_e164 alias", () => {
  const result = resolveVariables({ 1: "phone_e164" }, contact);
  assert.deepEqual(result, ["+15551230000"]);
});

test("tags array is joined with comma", () => {
  const result = resolveVariables({ 1: "tags" }, { ...contact });
  assert.deepEqual(result, ["vip, loyal"]);
});
