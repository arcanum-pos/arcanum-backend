-- Ordering modes (bestelwijzen) — DOMAIN_MODEL.md "Self-ordering and station
-- screens", decision 13: an event has 1..n ways an order comes in ("Ter
-- plaatse", "Take away", "Alleen aan de kassa", …), each with its own menu,
-- where it's used (the event's QR and/or the kassa), how guests pay and
-- whether they order on a tab. One QR code and one number counter per event.
-- The mode is information on the order (a badge on the station screen) —
-- never routing: a product's prep station decides where it's made.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
CREATE TABLE IF NOT EXISTS event_order_modes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  catalog_id TEXT REFERENCES catalogs(id),
  self_order INTEGER NOT NULL DEFAULT 0,
  kassa INTEGER NOT NULL DEFAULT 1,
  pay_counter INTEGER NOT NULL DEFAULT 1,
  pay_bancontact INTEGER NOT NULL DEFAULT 0,
  tabs INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_order_modes_event ON event_order_modes(event_id, position);

-- The mode an order came in by, its name a snapshot (a mode can be renamed
-- or removed later). No foreign key: removing a mode leaves its tabs be.
ALTER TABLE tabs ADD COLUMN order_mode_id TEXT;
ALTER TABLE tabs ADD COLUMN order_mode_name TEXT;

-- Every event that has self-ordering set up gets one mode with its settings
-- — nothing changes for it. events.catalog_id, self_order_pay_counter,
-- self_order_pay_bancontact and self_order_tabs are read no more.
INSERT INTO event_order_modes (id, org_id, event_id, name, position, catalog_id, self_order, kassa, pay_counter, pay_bancontact, tabs, created_at)
SELECT lower(hex(randomblob(16))), org_id, id, 'Ter plaatse', 0, catalog_id, CASE WHEN catalog_id IS NULL THEN 0 ELSE 1 END, 1,
  self_order_pay_counter, self_order_pay_bancontact, self_order_tabs, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM events WHERE catalog_id IS NOT NULL OR self_order_enabled = 1;

UPDATE tabs SET
  order_mode_id = (SELECT m.id FROM event_order_modes m WHERE m.event_id = tabs.event_id),
  order_mode_name = (SELECT m.name FROM event_order_modes m WHERE m.event_id = tabs.event_id)
WHERE event_id IN (SELECT event_id FROM event_order_modes);
