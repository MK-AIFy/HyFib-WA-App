-- 032_order_lifecycle.sql — commerce order lifecycle (roadmap G16 core).
-- payment_link is provider-agnostic: operators (or a future gateway
-- integration) attach any checkout URL; lifecycle transitions are enforced
-- in the API with compare-and-swap updates.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_link TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
