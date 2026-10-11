-- A readable self-order link (DOMAIN_MODEL.md "Self-ordering and station
-- screens", decision 16): /bestel/<name>-<4 characters>, e.g.
-- /bestel/spaghetti-7kq2 — easy to type over from a poster, not guessable
-- in passing. The long code (self_order_code) keeps working, so QR codes
-- printed before stay valid; "new link" replaces both. Filled in for
-- existing events the first time the console lists them.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE events ADD COLUMN self_order_slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_self_order_slug ON events(self_order_slug);
