import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  userRepository,
  channelRepository,
  contactRepository,
  conversationRepository,
  messageRepository,
  closePool as closePersistencePool
} from "@hyfib/persistence";
import { closePool as closeDbPool } from "@hyfib/db";
import { getAgentPerformance } from "../dist/index.js";

// Agent performance report (roadmap G11) — end to end against a live DB with
// migration 028 applied: attributed outbound + closed conversation in, FRT /
// resolution / counts out. RUN_DB_TESTS=1 locally; CI service container.
const skip = !process.env.RUN_DB_TESTS;

test("getAgentPerformance aggregates sent/closed/FRT per agent and zero-fills idle agents", { skip }, async () => {
  const tenant = await tenantRepository.create("AgentPerf Tenant");
  const agent = await userRepository.create(tenant.id, {
    email: `perf-agent-${Date.now()}@example.com`,
    displayName: "Perf Agent",
    roles: ["support_agent"]
  });
  const idle = await userRepository.create(tenant.id, {
    email: `perf-idle-${Date.now()}@example.com`,
    displayName: "Idle Agent",
    roles: ["support_agent"]
  });
  const channel = await channelRepository.create(tenant.id, {
    wabaId: `waba-perf-${Date.now()}`,
    phoneNumberId: `pn-perf-${Date.now()}`,
    displayPhoneNumber: "+15550006001"
  });
  const contact = await contactRepository.create(tenant.id, { phoneE164: "+15550006002" });
  const conversation = await conversationRepository.findOrCreate(tenant.id, contact.id, channel.id);

  await messageRepository.create(tenant.id, {
    conversationId: conversation.id,
    direction: "inbound",
    status: "delivered",
    payload: { type: "text", text: "help me" }
  });
  await messageRepository.create(tenant.id, {
    conversationId: conversation.id,
    direction: "outbound",
    status: "sent",
    payload: { kind: "text", text: "On it!", actorId: agent.id },
    senderUserId: agent.id
  });
  await conversationRepository.setState(tenant.id, conversation.id, "closed", agent.id);

  const report = await getAgentPerformance(tenant.id, 7);
  assert.equal(report.days, 7);
  const agents = report.agents;
  const perf = agents.find((a) => a.userId === agent.id);
  assert.ok(perf, "acting agent present in the report");
  assert.equal(perf.messagesSent, 1);
  assert.equal(perf.conversationsClosed, 1);
  assert.equal(perf.firstResponses, 1);
  assert.ok(perf.avgFirstResponseMinutes !== null && perf.avgFirstResponseMinutes >= 0);
  assert.ok(perf.avgResolutionMinutes !== null && perf.avgResolutionMinutes >= 0);

  const idlePerf = agents.find((a) => a.userId === idle.id);
  assert.ok(idlePerf, "idle agent still listed");
  assert.equal(idlePerf.messagesSent, 0);
  assert.equal(idlePerf.conversationsClosed, 0);
  assert.equal(idlePerf.avgFirstResponseMinutes, null);
});

test("reopening a conversation clears resolution tracking", { skip }, async () => {
  const tenant = await tenantRepository.create("AgentPerf Reopen Tenant");
  const agent = await userRepository.create(tenant.id, {
    email: `perf-reopen-${Date.now()}@example.com`,
    displayName: "Reopen Agent",
    roles: ["support_agent"]
  });
  const channel = await channelRepository.create(tenant.id, {
    wabaId: `waba-ro-${Date.now()}`,
    phoneNumberId: `pn-ro-${Date.now()}`,
    displayPhoneNumber: "+15550006003"
  });
  const contact = await contactRepository.create(tenant.id, { phoneE164: "+15550006004" });
  const conversation = await conversationRepository.findOrCreate(tenant.id, contact.id, channel.id);

  await conversationRepository.setState(tenant.id, conversation.id, "closed", agent.id);
  await conversationRepository.setState(tenant.id, conversation.id, "open");

  const report = await getAgentPerformance(tenant.id, 7);
  const perf = report.agents.find((a) => a.userId === agent.id);
  assert.equal(perf?.conversationsClosed ?? 0, 0, "reopen cleared the closed stamp");
});

test.after(async () => {
  if (!skip) {
    await closePersistencePool();
    await closeDbPool();
  }
});
