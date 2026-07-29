import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  channelRepository,
  contactRepository,
  conversationRepository,
  flowRepository,
  closePool
} from "../dist/index.js";

// Chatbot flows (roadmap G14). Requires migration 031. RUN_DB_TESTS=1 locally.
const skip = !process.env.RUN_DB_TESTS;

const DEFINITION = {
  start: "greet",
  nodes: {
    greet: { type: "message", text: "Hello!", next: "done" },
    done: { type: "end" }
  }
};

test("flow lifecycle: create → trigger lookup → session start/advance/complete", { skip }, async () => {
  const tenant = await tenantRepository.create("Flow Tenant");
  const channel = await channelRepository.create(tenant.id, {
    wabaId: `waba-flow-${Date.now()}`,
    phoneNumberId: `pn-flow-${Date.now()}`,
    displayPhoneNumber: "+15550401111"
  });
  const contact = await contactRepository.create(tenant.id, { phoneE164: "+15550402222" });
  const conversation = await conversationRepository.findOrCreate(tenant.id, contact.id, channel.id);

  const flow = await flowRepository.create(tenant.id, {
    name: "Menu bot",
    triggerKeyword: "Menu",
    definition: DEFINITION
  });
  assert.equal(flow.status, "draft");
  assert.deepEqual(flow.definition, DEFINITION);

  // Draft flows never trigger; activation makes the keyword live, case-insensitively.
  assert.equal(await flowRepository.findByTrigger(tenant.id, "menu"), undefined);
  await flowRepository.setStatus(tenant.id, flow.id, "active");
  assert.equal((await flowRepository.findByTrigger(tenant.id, "  MENU  "))?.id, flow.id);
  assert.equal(await flowRepository.findByTrigger(tenant.id, "menus"), undefined, "exact match only");

  const session = await flowRepository.startSession(tenant.id, {
    flowId: flow.id,
    conversationId: conversation.id,
    contactId: contact.id,
    currentNode: "greet"
  });
  assert.equal(session?.currentNode, "greet");

  // One active session per conversation — a second start is a silent no-op.
  const dup = await flowRepository.startSession(tenant.id, {
    flowId: flow.id,
    conversationId: conversation.id,
    contactId: contact.id,
    currentNode: "greet"
  });
  assert.equal(dup, undefined);

  await flowRepository.updateSession(tenant.id, session.id, { currentNode: "done" });
  const active = await flowRepository.activeSessionForConversation(tenant.id, conversation.id);
  assert.equal(active?.currentNode, "done");

  await flowRepository.updateSession(tenant.id, session.id, { status: "completed" });
  assert.equal(await flowRepository.activeSessionForConversation(tenant.id, conversation.id), undefined);

  // With the first session completed, a new one may start.
  const again = await flowRepository.startSession(tenant.id, {
    flowId: flow.id,
    conversationId: conversation.id,
    contactId: contact.id,
    currentNode: "greet"
  });
  assert.ok(again);

  const listed = await flowRepository.list(tenant.id);
  assert.equal(listed[0].activeSessions, 1);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
