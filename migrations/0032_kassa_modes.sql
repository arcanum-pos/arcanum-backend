-- Ordering modes at the kassa: one switch per event (DOMAIN_MODEL.md
-- "Self-ordering and station screens", decision 13, revised 2026-10-12),
-- off by default — instead of a switch per mode. On: the kassa shows the
-- event's ordering modes as buttons, the one chosen labels a new order
-- (useful with one station and shared products). Off: the kassa asks
-- nothing, kassa orders get no ordering mode. event_order_modes.kassa is
-- read no more.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE events ADD COLUMN kassa_modes INTEGER NOT NULL DEFAULT 0;
