-- Per-tenant WhatsApp credentials and message-history support.

-- Optional per-channel access token (AES-256-GCM ciphertext produced by the
-- application's encryptSecret helper). NULL means "use the shared env token",
-- preserving the single-WABA local-dev setup.
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS access_token_encrypted TEXT;

-- Efficient retrieval of a conversation thread in chronological order.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
