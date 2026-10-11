-- Device keys (DOMAIN_MODEL.md "Devices: control plane and data plane",
-- decided 2026-10-12): a station screen or customer display is paired with
-- its pairing code alone — no person signed in — and gets its own key, kept
-- in the browser as a cookie by arcanum-bff. The key allows only that
-- device's own few things (its station's tickets; its kassa's payment
-- status; its notification socket). Valid until the device is removed in
-- the console. Only the key's SHA-256 is stored. A kassa still needs a
-- person signed in.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
CREATE TABLE IF NOT EXISTS device_keys (
  key_hash TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('station', 'cfd')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_keys_terminal ON device_keys(terminal_id);
