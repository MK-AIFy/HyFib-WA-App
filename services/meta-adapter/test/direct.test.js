import test from "node:test";
import assert from "node:assert/strict";
import { sendTemplateDirect, markReadDirect } from "../dist/index.js";

test("sendTemplateDirect returns 400 when required fields are missing", async () => {
  const res = await sendTemplateDirect({ phoneNumberId: "PNID" }, "req-1");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Missing required fields for template send");
});

test("markReadDirect returns 400 when phoneNumberId/messageId are missing", async () => {
  const res = await markReadDirect({ phoneNumberId: "PNID" }, "req-2");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "phoneNumberId and messageId are required");
});
