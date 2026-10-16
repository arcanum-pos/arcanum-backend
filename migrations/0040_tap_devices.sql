-- A kassa's Tap to Pay phone (2026-10-16): a device of its own, role 'tap',
-- paired with a code for one kassa (like a customer display) — the kassa's
-- SumUp Tap to Pay payments go to it. Both tables are rebuilt: SQLite can't
-- change a CHECK constraint in place.
CREATE TABLE device_pairings_rebuilt (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  code_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('pos', 'cfd', 'station', 'tap')),
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by TEXT,
  terminal_id TEXT,
  revoked_at TEXT,
  link_to TEXT,
  station_id TEXT,
  view TEXT
);
INSERT INTO device_pairings_rebuilt (id, org_id, code_hash, role, name, created_by, created_at, expires_at, claimed_at, claimed_by, terminal_id, revoked_at, link_to, station_id, view)
  SELECT id, org_id, code_hash, role, name, created_by, created_at, expires_at, claimed_at, claimed_by, terminal_id, revoked_at, link_to, station_id, view FROM device_pairings;
DROP TABLE device_pairings;
ALTER TABLE device_pairings_rebuilt RENAME TO device_pairings;
CREATE INDEX IF NOT EXISTS idx_device_pairings_code ON device_pairings(code_hash);
CREATE INDEX IF NOT EXISTS idx_device_pairings_org ON device_pairings(org_id, created_at);

CREATE TABLE device_keys_rebuilt (
  key_hash TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('station', 'cfd', 'tap')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
INSERT INTO device_keys_rebuilt (key_hash, terminal_id, org_id, role, created_at, revoked_at)
  SELECT key_hash, terminal_id, org_id, role, created_at, revoked_at FROM device_keys;
DROP TABLE device_keys;
ALTER TABLE device_keys_rebuilt RENAME TO device_keys;
CREATE INDEX IF NOT EXISTS idx_device_keys_terminal ON device_keys(terminal_id);

-- A device's Web Push subscription (a Tap to Pay phone: "€12,50 aan de
-- kassa" while it's locked). Gone with the device.
CREATE TABLE IF NOT EXISTS device_push_subscriptions (
  terminal_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  subscription TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
