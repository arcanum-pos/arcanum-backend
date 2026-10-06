-- Device pairing (DOMAIN_MODEL.md "Devices: control plane and data plane"):
-- a device — kassa or customer display — is registered only by claiming a
-- code an admin made in the console. Only the code's SHA-256 is stored.
-- Rows are kept 30 days (the console's recent history), then deleted.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
CREATE TABLE IF NOT EXISTS device_pairings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  code_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('pos', 'cfd')),
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by TEXT,
  terminal_id TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_pairings_code ON device_pairings(code_hash);
CREATE INDEX IF NOT EXISTS idx_device_pairings_org ON device_pairings(org_id, created_at);

-- Failed claims per person (issuer + sub), for the rate limit: a code is 8
-- characters, so guessing is hopeless anyway — this keeps it that way.
CREATE TABLE IF NOT EXISTS device_pairing_failures (
  caller TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_pairing_failures ON device_pairing_failures(caller, at);
