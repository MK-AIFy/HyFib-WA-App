import test from "node:test";
import assert from "node:assert/strict";
import { validateInteractivePayload } from "../dist/validation.js";

test("accepts a valid button payload and strips unknown fields", () => {
  const result = validateInteractivePayload({
    interactiveType: "button",
    bodyText: "Pick one",
    headerText: "Hello",
    footerText: "Bye",
    buttons: [
      { id: "yes", title: "Yes", extra: "dropped" },
      { id: "no", title: "No" }
    ],
    unknownField: "dropped"
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    interactiveType: "button",
    bodyText: "Pick one",
    headerText: "Hello",
    footerText: "Bye",
    buttons: [
      { id: "yes", title: "Yes" },
      { id: "no", title: "No" }
    ]
  });
});

test("accepts a valid list payload", () => {
  const result = validateInteractivePayload({
    interactiveType: "list",
    bodyText: "Choose a product",
    buttonLabel: "Browse",
    sections: [
      { title: "Shoes", rows: [{ id: "s1", title: "Sneaker", description: "Red" }] },
      { rows: [{ id: "s2", title: "Boot" }] }
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.sections.length, 2);
  assert.deepEqual(result.value.sections[0].rows[0], { id: "s1", title: "Sneaker", description: "Red" });
  assert.equal("title" in result.value.sections[1], false);
});

test("rejects non-object input", () => {
  assert.equal(validateInteractivePayload(undefined).ok, false);
  assert.equal(validateInteractivePayload("text").ok, false);
  assert.equal(validateInteractivePayload([]).ok, false);
});

test("rejects an unknown interactiveType", () => {
  const result = validateInteractivePayload({ interactiveType: "carousel", bodyText: "x" });
  assert.equal(result.ok, false);
  assert.match(result.error, /interactiveType/);
});

test("rejects missing or oversized bodyText", () => {
  assert.equal(validateInteractivePayload({ interactiveType: "button", buttons: [{ id: "a", title: "A" }] }).ok, false);
  const result = validateInteractivePayload({
    interactiveType: "button",
    bodyText: "x".repeat(1025),
    buttons: [{ id: "a", title: "A" }]
  });
  assert.equal(result.ok, false);
});

test("rejects more than three buttons", () => {
  const result = validateInteractivePayload({
    interactiveType: "button",
    bodyText: "Pick",
    buttons: [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
      { id: "d", title: "D" }
    ]
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /1-3/);
});

test("rejects duplicate button ids and oversized titles", () => {
  const duplicate = validateInteractivePayload({
    interactiveType: "button",
    bodyText: "Pick",
    buttons: [
      { id: "same", title: "A" },
      { id: "same", title: "B" }
    ]
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /unique/);

  const longTitle = validateInteractivePayload({
    interactiveType: "button",
    bodyText: "Pick",
    buttons: [{ id: "a", title: "x".repeat(21) }]
  });
  assert.equal(longTitle.ok, false);
});

test("rejects a list without sections or with empty rows", () => {
  assert.equal(validateInteractivePayload({ interactiveType: "list", bodyText: "x", sections: [] }).ok, false);
  assert.equal(
    validateInteractivePayload({ interactiveType: "list", bodyText: "x", sections: [{ rows: [] }] }).ok,
    false
  );
});

test("rejects a list with more than ten rows in total", () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({ id: `r${index}`, title: `Row ${index}` }));
  const result = validateInteractivePayload({
    interactiveType: "list",
    bodyText: "x",
    sections: [{ rows: rows.slice(0, 6) }, { rows: rows.slice(6) }]
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /10 rows/);
});

test("rejects duplicate row ids across sections", () => {
  const result = validateInteractivePayload({
    interactiveType: "list",
    bodyText: "x",
    sections: [{ rows: [{ id: "dup", title: "A" }] }, { rows: [{ id: "dup", title: "B" }] }]
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unique/);
});
