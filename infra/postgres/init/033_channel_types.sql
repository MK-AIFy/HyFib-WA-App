-- 033_channel_types.sql — multi-channel (Phase F): Messenger/Instagram
-- channels live in the same table; channel_type discriminates. For social
-- channels phone_number_id holds the page/IG account id — the inbound
-- resolver (resolve_channel_by_phone_number_id) then routes page ids exactly
-- like WhatsApp phone-number ids, with zero resolver changes.
ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS channel_type TEXT NOT NULL DEFAULT 'whatsapp';
