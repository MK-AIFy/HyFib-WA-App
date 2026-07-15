import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedText,
  clampInt,
  parseContactListQuery,
  parseListQuery,
  parseOptionalIsoDate,
  validateCampaignBody,
  validateInteractivePayload,
  validateTemplatePayload,
  validateLocationPayload,
  validateContactsPayload,
  findLastInboundExternalId
} from "../dist/validation.js";

test("parseListQuery clamps limit and defaults offset", () => {
  const a = parseListQuery(new URLSearchParams("limit=500&offset=40"));
  assert.equal(a.limit, 100);
  assert.equal(a.offset, 40);
  const b = parseListQuery(new URLSearchParams(""));
  assert.equal(b.limit, 25);
  assert.equal(b.offset, 0);
  const c = parseListQuery(new URLSearchParams("limit=-3&offset=-1"));
  assert.equal(c.limit, 25);
  assert.equal(c.offset, 0);
});

test("boundedText trims, requires content, and enforces max length", () => {
  assert.deepEqual(boundedText("  hi  ", 10), { ok: true, value: "hi" });
  assert.equal(boundedText("", 10).ok, false);
  assert.equal(boundedText("   ", 10).ok, false);
  assert.equal(boundedText(123, 10).ok, false);
  assert.equal(boundedText("abcdef", 3).ok, false);
});

test("parseOptionalIsoDate accepts ISO, rejects garbage, allows absent", () => {
  assert.deepEqual(parseOptionalIsoDate(undefined), { ok: true, value: undefined });
  assert.deepEqual(parseOptionalIsoDate(""), { ok: true, value: undefined });
  const ok = parseOptionalIsoDate("2026-06-28T10:00:00Z");
  assert.equal(ok.ok, true);
  assert.equal(ok.value, "2026-06-28T10:00:00.000Z");
  assert.equal(parseOptionalIsoDate("not-a-date").ok, false);
  assert.equal(parseOptionalIsoDate(42).ok, false);
});

test("clampInt clamps into range and falls back on invalid", () => {
  assert.equal(clampInt(5, 1, 10, 3), 5);
  assert.equal(clampInt(99, 1, 10, 3), 10);
  assert.equal(clampInt(-4, 1, 10, 3), 1);
  assert.equal(clampInt("abc", 1, 10, 3), 3);
});

test("parseContactListQuery clamps limit, parses filters, defaults offset", () => {
  const a = parseContactListQuery(new URLSearchParams("q= vip &tag=lead&optedOut=true&limit=500&offset=40"));
  assert.equal(a.query, "vip");
  assert.equal(a.tag, "lead");
  assert.equal(a.optedOut, true);
  assert.equal(a.limit, 100);
  assert.equal(a.offset, 40);

  const b = parseContactListQuery(new URLSearchParams(""));
  assert.equal(b.query, undefined);
  assert.equal(b.tag, undefined);
  assert.equal(b.optedOut, undefined);
  assert.equal(b.limit, 25);
  assert.equal(b.offset, 0);

  const c = parseContactListQuery(new URLSearchParams("optedOut=false&limit=-3&offset=-1"));
  assert.equal(c.optedOut, false);
  assert.equal(c.limit, 25);
  assert.equal(c.offset, 0);
});

test("validateCampaignBody accepts a minimal payload with no optional fields", () => {
  assert.deepEqual(validateCampaignBody({}), { ok: true });
});

test("validateCampaignBody accepts a fully-populated valid payload", () => {
  assert.deepEqual(
    validateCampaignBody({
      segmentId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      ratePerMinute: 60,
      quietHours: { startHour: 22, endHour: 8 },
      frequencyCap: { maxMessages: 3, periodHours: 24 }
    }),
    { ok: true }
  );
});

test("validateCampaignBody rejects a non-UUID segmentId", () => {
  const r = validateCampaignBody({ segmentId: "not-a-uuid" });
  assert.equal(r.ok, false);
  assert.match(r.error, /segmentId/);
});

test("validateCampaignBody rejects ratePerMinute out of range", () => {
  assert.equal(validateCampaignBody({ ratePerMinute: 0 }).ok, false);
  assert.equal(validateCampaignBody({ ratePerMinute: 10_001 }).ok, false);
  assert.equal(validateCampaignBody({ ratePerMinute: 1.5 }).ok, false);
  assert.equal(validateCampaignBody({ ratePerMinute: "fast" }).ok, false);
  assert.equal(validateCampaignBody({ ratePerMinute: 1 }).ok, true);
  assert.equal(validateCampaignBody({ ratePerMinute: 10_000 }).ok, true);
});

test("validateCampaignBody rejects malformed quietHours", () => {
  assert.equal(validateCampaignBody({ quietHours: "22-8" }).ok, false);
  assert.equal(validateCampaignBody({ quietHours: { startHour: -1, endHour: 8 } }).ok, false);
  assert.equal(validateCampaignBody({ quietHours: { startHour: 24, endHour: 8 } }).ok, false);
  assert.equal(validateCampaignBody({ quietHours: { startHour: 22, endHour: 8.5 } }).ok, false);
  assert.equal(validateCampaignBody({ quietHours: { startHour: 0, endHour: 23 } }).ok, true);
});

test("validateCampaignBody rejects malformed frequencyCap", () => {
  assert.equal(validateCampaignBody({ frequencyCap: { maxMessages: 0, periodHours: 24 } }).ok, false);
  assert.equal(validateCampaignBody({ frequencyCap: { maxMessages: 1001, periodHours: 24 } }).ok, false);
  assert.equal(validateCampaignBody({ frequencyCap: { maxMessages: 5, periodHours: 0 } }).ok, false);
  assert.equal(validateCampaignBody({ frequencyCap: { maxMessages: 5, periodHours: 169 } }).ok, false);
  assert.equal(validateCampaignBody({ frequencyCap: { maxMessages: 1, periodHours: 168 } }).ok, true);
});

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

test("accepts a valid cta_url payload and strips unknown fields", () => {
  const result = validateInteractivePayload({
    interactiveType: "cta_url",
    bodyText: "Check out our site",
    ctaDisplayText: "Visit us",
    ctaUrl: "https://example.com",
    buttons: [{ id: "should", title: "be stripped" }]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    interactiveType: "cta_url",
    bodyText: "Check out our site",
    ctaDisplayText: "Visit us",
    ctaUrl: "https://example.com"
  });
});

test("rejects cta_url with a missing ctaDisplayText", () => {
  const result = validateInteractivePayload({
    interactiveType: "cta_url",
    bodyText: "x",
    ctaUrl: "https://example.com"
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ctaDisplayText/);
});

test("rejects cta_url with a missing or non-http(s) ctaUrl", () => {
  const missing = validateInteractivePayload({ interactiveType: "cta_url", bodyText: "x", ctaDisplayText: "Visit" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /ctaUrl/);

  const badScheme = validateInteractivePayload({
    interactiveType: "cta_url",
    bodyText: "x",
    ctaDisplayText: "Visit",
    ctaUrl: "javascript:alert(1)"
  });
  assert.equal(badScheme.ok, false);
  assert.match(badScheme.error, /ctaUrl/);
});

test("rejects a cta_url ctaDisplayText longer than 20 characters", () => {
  const result = validateInteractivePayload({
    interactiveType: "cta_url",
    bodyText: "x",
    ctaDisplayText: "this label is way too long",
    ctaUrl: "https://example.com"
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ctaDisplayText/);
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

test("validateTemplatePayload accepts a minimal valid payload and trims name/language", () => {
  const result = validateTemplatePayload({ templateName: "  order_confirmation  ", templateLanguage: " en_US " });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { templateName: "order_confirmation", templateLanguage: "en_US" });
});

test("validateTemplatePayload accepts optional parameters and components", () => {
  const components = [{ type: "body", parameters: [{ type: "text", text: "12345" }] }];
  const result = validateTemplatePayload({
    templateName: "shipping_update",
    templateLanguage: "en_US",
    parameters: ["12345"],
    components
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.parameters, ["12345"]);
  assert.deepEqual(result.value.components, components);
});

test("validateTemplatePayload rejects non-object input", () => {
  assert.equal(validateTemplatePayload(undefined).ok, false);
  assert.equal(validateTemplatePayload("x").ok, false);
  assert.equal(validateTemplatePayload([]).ok, false);
});

test("validateTemplatePayload requires templateName", () => {
  const result = validateTemplatePayload({ templateLanguage: "en_US" });
  assert.equal(result.ok, false);
  assert.match(result.error, /templateName/);
});

test("validateTemplatePayload requires templateLanguage", () => {
  const result = validateTemplatePayload({ templateName: "order_confirmation" });
  assert.equal(result.ok, false);
  assert.match(result.error, /templateLanguage/);
});

test("validateTemplatePayload rejects a templateLanguage longer than 10 characters", () => {
  const result = validateTemplatePayload({ templateName: "x", templateLanguage: "en_US_extra_long" });
  assert.equal(result.ok, false);
  assert.match(result.error, /templateLanguage/);
});

test("validateTemplatePayload rejects non-array parameters", () => {
  const result = validateTemplatePayload({ templateName: "x", templateLanguage: "en_US", parameters: "not-an-array" });
  assert.equal(result.ok, false);
  assert.match(result.error, /parameters/);
});

test("validateTemplatePayload rejects more than 50 parameters", () => {
  const result = validateTemplatePayload({
    templateName: "x",
    templateLanguage: "en_US",
    parameters: Array.from({ length: 51 }, (_, i) => `p${i}`)
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /parameters/);
});

test("validateTemplatePayload rejects a non-string parameter entry", () => {
  const result = validateTemplatePayload({ templateName: "x", templateLanguage: "en_US", parameters: [123] });
  assert.equal(result.ok, false);
  assert.match(result.error, /string/);
});

test("validateTemplatePayload rejects a parameter entry longer than 1024 characters", () => {
  const result = validateTemplatePayload({
    templateName: "x",
    templateLanguage: "en_US",
    parameters: ["a".repeat(1025)]
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /1024/);
});

test("validateLocationPayload accepts a minimal valid payload", () => {
  const result = validateLocationPayload({ latitude: 37.4, longitude: -122.1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { latitude: 37.4, longitude: -122.1 });
});

test("validateLocationPayload accepts optional name/address", () => {
  const result = validateLocationPayload({
    latitude: 37.4,
    longitude: -122.1,
    name: "HQ",
    address: "1600 Amphitheatre Pkwy"
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.name, "HQ");
  assert.equal(result.value.address, "1600 Amphitheatre Pkwy");
});

test("validateLocationPayload rejects non-object input", () => {
  assert.equal(validateLocationPayload(undefined).ok, false);
  assert.equal(validateLocationPayload("x").ok, false);
  assert.equal(validateLocationPayload([]).ok, false);
});

test("validateLocationPayload rejects out-of-range or non-finite latitude", () => {
  assert.equal(validateLocationPayload({ latitude: 91, longitude: 0 }).ok, false);
  assert.equal(validateLocationPayload({ latitude: -91, longitude: 0 }).ok, false);
  assert.equal(validateLocationPayload({ latitude: Infinity, longitude: 0 }).ok, false);
  assert.equal(validateLocationPayload({ latitude: "37.4", longitude: 0 }).ok, false);
  assert.equal(validateLocationPayload({ longitude: 0 }).ok, false);
});

test("validateLocationPayload rejects out-of-range or non-finite longitude", () => {
  assert.equal(validateLocationPayload({ latitude: 0, longitude: 181 }).ok, false);
  assert.equal(validateLocationPayload({ latitude: 0, longitude: -181 }).ok, false);
  assert.equal(validateLocationPayload({ latitude: 0, longitude: NaN }).ok, false);
  assert.equal(validateLocationPayload({ latitude: 0 }).ok, false);
});

test("validateLocationPayload rejects an oversized name or address", () => {
  const nameResult = validateLocationPayload({ latitude: 0, longitude: 0, name: "x".repeat(201) });
  assert.equal(nameResult.ok, false);
  assert.match(nameResult.error, /location\.name/);

  const addressResult = validateLocationPayload({ latitude: 0, longitude: 0, address: "x".repeat(501) });
  assert.equal(addressResult.ok, false);
  assert.match(addressResult.error, /location\.address/);
});

test("validateContactsPayload accepts a minimal contact and strips unknown fields", () => {
  const result = validateContactsPayload([{ name: { formattedName: "Jane Doe" }, extra: "strip me" }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [{ name: { formattedName: "Jane Doe" } }]);
});

test("validateContactsPayload accepts a full contact with phones and emails", () => {
  const result = validateContactsPayload([
    {
      name: { formattedName: "Jane Doe", firstName: "Jane", lastName: "Doe" },
      phones: [{ phone: "+15551230000", type: "work" }],
      emails: [{ email: "jane@example.com" }]
    }
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [
    {
      name: { formattedName: "Jane Doe", firstName: "Jane", lastName: "Doe" },
      phones: [{ phone: "+15551230000", type: "work" }],
      emails: [{ email: "jane@example.com" }]
    }
  ]);
});

test("validateContactsPayload rejects non-array or empty input", () => {
  assert.equal(validateContactsPayload(undefined).ok, false);
  assert.equal(validateContactsPayload({}).ok, false);
  assert.equal(validateContactsPayload([]).ok, false);
});

test("validateContactsPayload rejects more than 20 contacts", () => {
  const contacts = Array.from({ length: 21 }, () => ({ name: { formattedName: "X" } }));
  const result = validateContactsPayload(contacts);
  assert.equal(result.ok, false);
  assert.match(result.error, /1-20/);
});

test("validateContactsPayload rejects a contact missing name.formattedName", () => {
  const missingName = validateContactsPayload([{}]);
  assert.equal(missingName.ok, false);
  assert.match(missingName.error, /formattedName/);

  const emptyName = validateContactsPayload([{ name: {} }]);
  assert.equal(emptyName.ok, false);
  assert.match(emptyName.error, /formattedName/);
});

test("validateContactsPayload rejects a phone entry missing phone", () => {
  const result = validateContactsPayload([{ name: { formattedName: "Jane" }, phones: [{ type: "work" }] }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /phone/);
});

test("validateContactsPayload rejects more than 10 phones", () => {
  const phones = Array.from({ length: 11 }, (_, i) => ({ phone: `+1555123000${i}` }));
  const result = validateContactsPayload([{ name: { formattedName: "Jane" }, phones }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /phones/);
});

test("validateContactsPayload rejects an email entry missing email", () => {
  const result = validateContactsPayload([{ name: { formattedName: "Jane" }, emails: [{ type: "work" }] }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /email/);
});

test("validateContactsPayload rejects more than 10 emails", () => {
  const emails = Array.from({ length: 11 }, (_, i) => ({ email: `jane${i}@example.com` }));
  const result = validateContactsPayload([{ name: { formattedName: "Jane" }, emails }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /emails/);
});

test("validateContactsPayload omits empty phones/emails arrays from the cleaned value", () => {
  const result = validateContactsPayload([{ name: { formattedName: "Jane Doe" }, phones: [], emails: [] }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [{ name: { formattedName: "Jane Doe" } }]);
});

test("findLastInboundExternalId returns the most recent inbound message's external id", () => {
  const messages = [
    { direction: "inbound", externalMessageId: "wamid.old" },
    { direction: "outbound", externalMessageId: "wamid.reply" },
    { direction: "inbound", externalMessageId: "wamid.newest" }
  ];
  assert.equal(findLastInboundExternalId(messages), "wamid.newest");
});

test("findLastInboundExternalId skips inbound messages with no externalMessageId", () => {
  const messages = [{ direction: "inbound", externalMessageId: "wamid.old" }, { direction: "inbound" }];
  assert.equal(findLastInboundExternalId(messages), "wamid.old");
});

test("findLastInboundExternalId returns undefined when there is no inbound message", () => {
  const messages = [
    { direction: "outbound", externalMessageId: "wamid.a" },
    { direction: "outbound", externalMessageId: "wamid.b" }
  ];
  assert.equal(findLastInboundExternalId(messages), undefined);
});

test("findLastInboundExternalId returns undefined for an empty list", () => {
  assert.equal(findLastInboundExternalId([]), undefined);
});
