-- Self-ordering, prep tickets and station screens (DOMAIN_MODEL.md
-- "Self-ordering and station screens", agreed 2026-10-11).
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote

-- An event's menu, self-ordering (on/off, the code in its public URL/QR) and
-- its own short order numbers (1, 2, 3…; resettable to 1).
ALTER TABLE events ADD COLUMN catalog_id TEXT REFERENCES catalogs(id);
ALTER TABLE events ADD COLUMN self_order_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN self_order_code TEXT;
ALTER TABLE events ADD COLUMN order_counter INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_self_order_code ON events(self_order_code);

-- A tab's short number within its event, where it came from ('kassa' |
-- 'self_order'), and the unguessable token of its "follow your order" page.
ALTER TABLE tabs ADD COLUMN event_number INTEGER;
ALTER TABLE tabs ADD COLUMN source TEXT NOT NULL DEFAULT 'kassa';
ALTER TABLE tabs ADD COLUMN order_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tabs_order_token ON tabs(order_token);
CREATE INDEX IF NOT EXISTS idx_tabs_event_status ON tabs(event_id, status);

-- A prep ticket (bon): the part of one order that goes to one station,
-- with its status: ordered → in_progress → ready → delivered.
CREATE TABLE IF NOT EXISTS prep_tickets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  tab_id TEXT NOT NULL REFERENCES tabs(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  station_id TEXT NOT NULL,
  station_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ordered', 'in_progress', 'ready', 'delivered')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_prep_tickets_station ON prep_tickets(org_id, station_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prep_tickets_tab ON prep_tickets(tab_id);

-- Which station a station screen (device role 'station') shows.
CREATE TABLE IF NOT EXISTS station_devices (
  terminal_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  station_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Pairing codes for station screens: role 'station' and its station. The
-- table is rebuilt — SQLite can't change a CHECK constraint in place.
CREATE TABLE device_pairings_rebuilt (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  code_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('pos', 'cfd', 'station')),
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by TEXT,
  terminal_id TEXT,
  revoked_at TEXT,
  link_to TEXT,
  station_id TEXT
);
INSERT INTO device_pairings_rebuilt (id, org_id, code_hash, role, name, created_by, created_at, expires_at, claimed_at, claimed_by, terminal_id, revoked_at, link_to)
  SELECT id, org_id, code_hash, role, name, created_by, created_at, expires_at, claimed_at, claimed_by, terminal_id, revoked_at, link_to FROM device_pairings;
DROP TABLE device_pairings;
ALTER TABLE device_pairings_rebuilt RENAME TO device_pairings;
CREATE INDEX IF NOT EXISTS idx_device_pairings_code ON device_pairings(code_hash);
CREATE INDEX IF NOT EXISTS idx_device_pairings_org ON device_pairings(org_id, created_at);
