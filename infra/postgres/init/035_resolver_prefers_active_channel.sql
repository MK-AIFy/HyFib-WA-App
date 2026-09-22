-- Route inbound to the ACTIVE channel row for a phone number.
--
-- resolve_channel_by_phone_number_id (003_functions.sql) took the oldest row
-- for a phone number and ignored is_active entirely:
--
--   ORDER BY created_at ASC LIMIT 1
--
-- whatsapp_channels has no uniqueness on phone_number_id and
-- channelRepository.create does not check for duplicates, so deactivating a
-- number and registering it again leaves two rows for the same business
-- number. Inbound then kept resolving to the DEACTIVATED row, while outbound
-- (channelRepository.firstActive) used the active one. The two sides disagreed
-- about which row was "the" channel for as long as both rows existed: inbound
-- conversations piled up under a channel the operator had switched off, and the
-- send path could not see them.
--
-- is_active DESC puts an active row ahead of an inactive one. The tie-break
-- stays created_at ASC so that anything not involving a deactivated duplicate --
-- the normal single-row case, and the misconfiguration where two rows for one
-- number are both active -- resolves exactly as it does today. This is
-- deliberately the smallest change that fixes the reported defect.
--
-- The inactive row is a FALLBACK, not excluded: if every row for a number is
-- deactivated, filtering them out would make the function return no rows, the
-- gateway would answer channel_not_found, and the webhook would be dropped.
-- Deactivating a channel must not silently discard inbound customer messages --
-- a STOP among them would be lost, and an unhonoured STOP is a compliance
-- failure. Recording the message against the switched-off channel is the far
-- better outcome.
--
-- Consequence worth knowing at deploy time: where a duplicate already exists,
-- inbound moves to the active row from here on, so that contact's older
-- conversation stays on the old row and a new one is created on the new row --
-- the inbox shows the history split at this moment. That is inherent to routing
-- to the live row. The 24h session window is unaffected, because
-- lastInboundAtForChannel keys on phone_number_id and so spans both rows.
--
-- Note also that resolveChannelByPhoneNumberId caches its answer for 5 minutes
-- (CHANNEL_CREDS_TTL_MS), so activating or deactivating a channel takes up to
-- that long to change routing.

CREATE OR REPLACE FUNCTION resolve_channel_by_phone_number_id(p_phone_number_id TEXT)
RETURNS TABLE (tenant_id UUID, channel_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id, id AS channel_id
  FROM whatsapp_channels
  WHERE phone_number_id = p_phone_number_id
  ORDER BY is_active DESC, created_at ASC
  LIMIT 1;
$$;

-- CREATE OR REPLACE keeps the existing privileges, so this only matters where
-- 034 has not been applied (it is on a separate branch at the time of writing).
-- Re-asserting makes the intended state hold either way, and both statements
-- are no-ops when it is already correct.
REVOKE EXECUTE ON FUNCTION resolve_channel_by_phone_number_id(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_channel_by_phone_number_id(TEXT) TO hyfib_app;
