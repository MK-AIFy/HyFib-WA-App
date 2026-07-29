import test from "node:test";
import assert from "node:assert/strict";
import { tenantRepository, contactRepository, orderRepository, closePool } from "../dist/index.js";

// Order lifecycle (roadmap G16 core). Requires migration 032. RUN_DB_TESTS=1.
const skip = !process.env.RUN_DB_TESTS;

test("order lifecycle: CAS transitions enforce the legal path; payment link round-trips", { skip }, async () => {
  const tenant = await tenantRepository.create("Order Lifecycle Tenant");
  const contact = await contactRepository.create(tenant.id, { phoneE164: "+15550701111" });
  const order = await orderRepository.create(tenant.id, {
    contactId: contact.id,
    externalOrderId: `ord-${Date.now()}`,
    amountMinor: 49900,
    currency: "INR"
  });
  assert.equal(order.status, "created");

  // paid from created is illegal — CAS matches nothing.
  assert.equal(await orderRepository.transition(tenant.id, order.id, ["confirmed"], "paid"), undefined);

  const confirmed = await orderRepository.transition(tenant.id, order.id, ["created"], "confirmed");
  assert.equal(confirmed?.status, "confirmed");

  const linked = await orderRepository.setPaymentLink(tenant.id, order.id, "https://pay.example.com/x");
  assert.equal(linked?.paymentLink, "https://pay.example.com/x");

  const paid = await orderRepository.transition(tenant.id, order.id, ["confirmed"], "paid");
  assert.equal(paid?.status, "paid");
  assert.equal(paid?.paymentLink, "https://pay.example.com/x");

  // Terminal: cancel after paid is illegal.
  assert.equal(await orderRepository.transition(tenant.id, order.id, ["created", "confirmed"], "cancelled"), undefined);

  const cleared = await orderRepository.setPaymentLink(tenant.id, order.id, null);
  assert.equal(cleared?.paymentLink, undefined);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
