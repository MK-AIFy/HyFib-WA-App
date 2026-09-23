import test from "node:test";
import assert from "node:assert/strict";
import { tenantRepository, channelRepository, resolveChannelByPhoneNumberId, closePool } from "../dist/index.js";

/**
 * Which channel row an inbound webhook is attributed to.
 *
 * resolve_channel_by_phone_number_id used to take the oldest row for a phone number and ignore is_active, so
 * after a number was deactivated and registered again, inbound kept landing on the switched-off row while
 * sends went out on the active one. Migration 035 prefers an active row, keeping created_at ASC as the
 * tie-break so nothing else moves.
 *
 * Every test uses a fresh phone_number_id: resolveChannelByPhoneNumberId memoises its answer for 5 minutes
 * (CHANNEL_CREDS_TTL_MS), so reusing an id across cases would read a cached result rather than the database.
 *
 * Requires a live PostgreSQL with the schema applied. CI provides it; locally run with RUN_DB_TESTS=1.
 */
const skip = !process.env.RUN_DB_TESTS;

let sequence = 0;
function uniquePhoneNumberId(label) {
  sequence += 1;
  return `pn-${label}-${Date.now()}-${sequence}-${Math.floor(Math.random() * 100000)}`;
}

async function makeChannel(tenantId, phoneNumberId, suffix) {
  return channelRepository.create(tenantId, {
    wabaId: `waba-${suffix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    phoneNumberId,
    displayPhoneNumber: "+15550001234"
  });
}

test("a single channel resolves to itself", { skip }, async () => {
  const tenant = await tenantRepository.create(`Resolver Single ${Date.now()}`);
  const phoneNumberId = uniquePhoneNumberId("single");
  const channel = await makeChannel(tenant.id, phoneNumberId, "only");

  const resolved = await resolveChannelByPhoneNumberId(phoneNumberId);
  assert.equal(resolved?.channelId, channel.id);
  assert.equal(resolved?.tenantId, tenant.id);
});

test("a re-registered number resolves to the active row, not the deactivated original", { skip }, async () => {
  // The defect: inbound kept landing on the row the operator had switched off, while firstActive sent from
  // the new one — so the two sides disagreed about which row was the channel for as long as both existed.
  const tenant = await tenantRepository.create(`Resolver Rereg ${Date.now()}`);
  const phoneNumberId = uniquePhoneNumberId("rereg");

  const oldChannel = await makeChannel(tenant.id, phoneNumberId, "old");
  await channelRepository.update(tenant.id, oldChannel.id, { isActive: false });
  const newChannel = await makeChannel(tenant.id, phoneNumberId, "new");

  const resolved = await resolveChannelByPhoneNumberId(phoneNumberId);
  assert.equal(resolved?.channelId, newChannel.id, "inbound must follow the active registration");
  assert.notEqual(resolved?.channelId, oldChannel.id);
});

test(
  "when every row for a number is deactivated, inbound still resolves rather than being dropped",
  { skip },
  async () => {
    // Deliberately a fallback, not an exclusion. Returning no row would make the gateway answer
    // channel_not_found and discard the webhook — losing customer messages, and a STOP among them would go
    // unhonoured. Recording against the switched-off channel is the better failure.
    const tenant = await tenantRepository.create(`Resolver AllOff ${Date.now()}`);
    const phoneNumberId = uniquePhoneNumberId("alloff");

    const channel = await makeChannel(tenant.id, phoneNumberId, "off");
    await channelRepository.update(tenant.id, channel.id, { isActive: false });

    const resolved = await resolveChannelByPhoneNumberId(phoneNumberId);
    assert.equal(resolved?.channelId, channel.id, "an inactive channel must still receive its inbound");
  }
);

test("with two active rows for one number the oldest still wins, as before", { skip }, async () => {
  // Tie-break deliberately unchanged: this misconfiguration resolves exactly as it did before 035, so the
  // migration moves only the case it set out to move.
  const tenant = await tenantRepository.create(`Resolver TwoActive ${Date.now()}`);
  const phoneNumberId = uniquePhoneNumberId("twoactive");

  const first = await makeChannel(tenant.id, phoneNumberId, "first");
  const second = await makeChannel(tenant.id, phoneNumberId, "second");

  const resolved = await resolveChannelByPhoneNumberId(phoneNumberId);
  assert.equal(resolved?.channelId, first.id, "created_at ASC remains the tie-break among active rows");
  assert.notEqual(resolved?.channelId, second.id);
});

test("an unknown phone number resolves to nothing", { skip }, async () => {
  const resolved = await resolveChannelByPhoneNumberId(uniquePhoneNumberId("absent"));
  assert.equal(resolved, undefined);
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
