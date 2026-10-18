-- Re-pairing a device (2026-10-18, DOMAIN_MODEL.md "Devices" → "Re-pairing"):
-- a code that makes a browser an existing device again — its identity, so
-- its name, links, station and history stay — instead of a new one.
-- `repairs`: the device a pairing code is for (NULL: a new device).
ALTER TABLE device_pairings ADD COLUMN repairs TEXT;

-- Which pairing a device is now (its last claim): a browser that was this
-- device before a re-pair stops being it (devices.ts getDevice). No row: a
-- device paired before this existed, or a kassa's own second window — not checked.
CREATE TABLE IF NOT EXISTS device_claims (
  terminal_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  pairing_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);
