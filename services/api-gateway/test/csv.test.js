import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, serializeContactsCsv } from "../dist/csv.js";

const buf = (s) => Buffer.from(s, "utf-8");

test("serializeContactsCsv emits importer-compatible header and escapes cells", () => {
  const csv = serializeContactsCsv([
    {
      phoneE164: "+15551230001",
      firstName: "Ann",
      lastName: "Lee",
      country: "US",
      timezone: "UTC",
      tags: ["vip", "lead"],
      optedOut: false
    },
    { phoneE164: "+15551230002", firstName: 'A,"B', tags: [], optedOut: true }
  ]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "phone_e164,first_name,last_name,country,timezone,tags,consent");
  assert.equal(lines[1], "+15551230001,Ann,Lee,US,UTC,vip|lead,true");
  assert.equal(lines[2], '+15551230002,"A,""B",,,,,false');
});

test("parses a minimal phone_e164 CSV", () => {
  const { rows, errors } = parseCsv(buf("phone_e164\n+15551230000\n+442071838750\n"));
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].phoneE164, "+15551230000");
  assert.equal(rows[1].phoneE164, "+442071838750");
});

test("parses all optional columns", () => {
  const csv =
    "phone_e164,first_name,last_name,country,timezone,tags,consent\n" +
    "+15551230000,Alice,Smith,US,America/New_York,vip|loyal,true\n";
  const { rows, errors } = parseCsv(buf(csv));
  assert.equal(errors.length, 0);
  const r = rows[0];
  assert.equal(r.firstName, "Alice");
  assert.equal(r.lastName, "Smith");
  assert.equal(r.country, "US");
  assert.equal(r.timezone, "America/New_York");
  assert.deepEqual(r.tags, ["vip", "loyal"]);
  assert.equal(r.consent, true);
});

test("accepts 'phone' as column alias", () => {
  const { rows, errors } = parseCsv(buf("phone\n+15551230000\n"));
  assert.equal(errors.length, 0);
  assert.equal(rows[0].phoneE164, "+15551230000");
});

test("skips invalid E.164 with error", () => {
  const csv = "phone_e164\n0551230000\n+15551230000\n";
  const { rows, errors } = parseCsv(buf(csv));
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not a valid E\.164/);
});

test("handles quoted fields and escaped quotes", () => {
  const csv = 'phone_e164,first_name\n"+15551230000","O\'Brien "\n';
  const { rows } = parseCsv(buf(csv));
  assert.equal(rows[0].phoneE164, "+15551230000");
});

test("returns error for missing phone column", () => {
  const { rows, errors } = parseCsv(buf("first_name,last_name\nAlice,Smith\n"));
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /phone_e164/);
});

test("returns error for empty CSV", () => {
  const { rows, errors } = parseCsv(buf(""));
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /empty/);
});

test("handles CRLF line endings", () => {
  const { rows, errors } = parseCsv(buf("phone_e164\r\n+15551230000\r\n"));
  assert.equal(errors.length, 0);
  assert.equal(rows[0].phoneE164, "+15551230000");
});

test("consent false values", () => {
  const csv = "phone_e164,consent\n+15551230000,false\n";
  const { rows } = parseCsv(buf(csv));
  assert.equal(rows[0].consent, false);
});

// ─── serializeCampaignRecipientsCsv (G10 campaign analytics export) ─────────

test("campaign recipients csv: header + rows with all funnel fields", async () => {
  const { serializeCampaignRecipientsCsv } = await import("../dist/csv.js");
  const csv = serializeCampaignRecipientsCsv([
    {
      phoneE164: "+15551230000",
      status: "delivered",
      sentAt: "2026-07-29T00:00:00.000Z",
      deliveredAt: "2026-07-29T00:00:05.000Z",
      externalMessageId: "wamid.X1"
    },
    { phoneE164: "+15551230001", status: "policy_skipped", skipReason: "quiet_hours" }
  ]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "phone_e164,status,error,skip_reason,sent_at,delivered_at,read_at,external_message_id");
  assert.equal(lines[1], "+15551230000,delivered,,,2026-07-29T00:00:00.000Z,2026-07-29T00:00:05.000Z,,wamid.X1");
  assert.equal(lines[2], "+15551230001,policy_skipped,,quiet_hours,,,,");
});

test("campaign recipients csv: quotes fields containing commas and quotes", async () => {
  const { serializeCampaignRecipientsCsv } = await import("../dist/csv.js");
  const csv = serializeCampaignRecipientsCsv([
    { phoneE164: "+15551230002", status: "failed", error: 'Meta said "no", try later' }
  ]);
  assert.equal(csv.split("\n")[1], '+15551230002,failed,"Meta said ""no"", try later",,,,,');
});

test("campaign recipients csv: empty list is just the header", async () => {
  const { serializeCampaignRecipientsCsv } = await import("../dist/csv.js");
  assert.equal(serializeCampaignRecipientsCsv([]).split("\n").length, 1);
});
