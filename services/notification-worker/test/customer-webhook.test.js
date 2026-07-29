import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signWebhookBody, deliverCustomerWebhook } from "../dist/customer-webhook.js";

test("signWebhookBody produces sha256=<hmac> over the exact body", () => {
  const body = '{"type":"message.status"}';
  const expected = `sha256=${createHmac("sha256", "whsec_1").update(body).digest("hex")}`;
  assert.equal(signWebhookBody("whsec_1", body), expected);
});

test("delivery POSTs the signed event and reports ok", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const event = { type: "message.status", occurredAt: "2026-07-29T00:00:00.000Z", data: { status: "delivered" } };
  const result = await deliverCustomerWebhook({ url: "https://cb.example.com/h", secret: "whsec_1" }, event, fetchImpl);

  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cb.example.com/h");
  assert.equal(calls[0].init.method, "POST");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.type, "message.status");
  assert.equal(calls[0].init.headers["x-hyfib-signature"], signWebhookBody("whsec_1", calls[0].init.body));
});

test("no secret → no signature header; network errors report ok:false without throwing", async () => {
  let headers;
  const okFetch = async (_url, init) => {
    headers = init.headers;
    return { ok: true, status: 204 };
  };
  await deliverCustomerWebhook(
    { url: "https://cb.example.com/h" },
    { type: "message.inbound", occurredAt: "x", data: {} },
    okFetch
  );
  assert.equal("x-hyfib-signature" in headers, false);

  const result = await deliverCustomerWebhook(
    { url: "https://cb.example.com/h", secret: "s" },
    { type: "message.inbound", occurredAt: "x", data: {} },
    async () => {
      throw new Error("ECONNREFUSED");
    }
  );
  assert.deepEqual(result, { ok: false });
});
