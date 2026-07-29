import test from "node:test";
import assert from "node:assert/strict";
import { buildRazorpayPaymentLinkBody, createRazorpayPaymentLink } from "../dist/payment-provider.js";

const REQUEST = { amountMinor: 49900, currency: "INR", description: "Order ord-1", referenceId: "uuid-1" };

test("builder emits Razorpay's payment_links shape with bounded description", () => {
  assert.deepEqual(buildRazorpayPaymentLinkBody(REQUEST), {
    amount: 49900,
    currency: "INR",
    description: "Order ord-1",
    reference_id: "uuid-1",
    notify: { sms: false, email: false }
  });
  const long = buildRazorpayPaymentLinkBody({ ...REQUEST, description: "x".repeat(400) });
  assert.equal(long.description.length, 255);
});

test("success: basic-auth POST to the payment_links endpoint, short_url returned", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ id: "plink_1", short_url: "https://rzp.io/i/abc" }) };
  };
  const result = await createRazorpayPaymentLink({ keyId: "rzp_key", keySecret: "rzp_secret" }, REQUEST, fetchImpl);

  assert.deepEqual(result, { ok: true, link: "https://rzp.io/i/abc", providerRef: "plink_1" });
  assert.equal(calls[0].url, "https://api.razorpay.com/v1/payment_links");
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from("rzp_key:rzp_secret").toString("base64")}`);
  assert.equal(JSON.parse(calls[0].init.body).reference_id, "uuid-1");
});

test("failures degrade to ok:false without throwing: no creds, API error, network error", async () => {
  assert.deepEqual(await createRazorpayPaymentLink({ keyId: "", keySecret: "" }, REQUEST), {
    ok: false,
    error: "razorpay_not_configured"
  });

  const apiError = await createRazorpayPaymentLink({ keyId: "k", keySecret: "s" }, REQUEST, async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { description: "Currency is not supported" } })
  }));
  assert.deepEqual(apiError, { ok: false, error: "Currency is not supported" });

  const network = await createRazorpayPaymentLink({ keyId: "k", keySecret: "s" }, REQUEST, async () => {
    throw new Error("ECONNRESET");
  });
  assert.deepEqual(network, { ok: false, error: "ECONNRESET" });
});
