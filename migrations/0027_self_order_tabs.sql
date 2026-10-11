-- Self-ordering on a tab (DOMAIN_MODEL.md "Self-ordering and station
-- screens", decision 12): an event can let guests keep ordering on their
-- tab and pay when they leave. The tab remembers it (pay_later), so it keeps
-- its rules even if the event's switch changes meanwhile.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE events ADD COLUMN self_order_tabs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tabs ADD COLUMN pay_later INTEGER NOT NULL DEFAULT 0;
