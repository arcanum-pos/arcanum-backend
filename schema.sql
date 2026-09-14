CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  amount_cents INTEGER NOT NULL,
  description TEXT,
  method TEXT NOT NULL,
  items TEXT,
  slot_id TEXT,
  device_id TEXT,
  device_name TEXT,
  user_name TEXT,
  user_email TEXT,
  -- Nullable only for backward compat with rows recorded before organization
  -- scoping existed; every new transaction is required to carry one.
  org_id TEXT,
  completed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_completed_at ON transactions(completed_at);
CREATE INDEX IF NOT EXISTS idx_transactions_slot_id ON transactions(slot_id);
CREATE INDEX IF NOT EXISTS idx_transactions_org_id ON transactions(org_id);

-- The `devices` table used to live here; it moved to questo-devicehub's own
-- D1 database (questo-devices-dev) so the two Workers don't share a database.

-- --- Organizations / admin portal ---
-- No separate "users" table: identity is the Auth0 `sub` forwarded by the BFF
-- (X-User-Sub), which is stable within this platform's one Auth0 tenant even
-- across different connections/IdPs. Invitations are keyed by email (the sub
-- isn't known until that person first logs in) and reconciled into a real
-- membership the next time that email's owner hits the API.

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo_url TEXT,
  theme TEXT,
  -- Envelope encryption: this org's own AES-256 data key, wrapped (encrypted)
  -- with the platform-wide ENCRYPTION_KEY secret. Never stored unwrapped.
  dek_ciphertext TEXT NOT NULL,
  dek_iv TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_sub TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_sub TEXT,
  invited_email TEXT NOT NULL,
  role TEXT NOT NULL, -- 'admin' | 'cashier'
  status TEXT NOT NULL, -- 'pending' | 'active'
  invited_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user_sub ON memberships(user_sub);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_org_email ON memberships(org_id, invited_email);

CREATE TABLE IF NOT EXISTS identity_providers (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  connection_name TEXT,
  issuer_url TEXT,
  client_id TEXT,
  client_secret_ciphertext TEXT,
  client_secret_iv TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_provider_credentials (
  org_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL, -- 'bancontact' | 'sumup'
  -- The whole provider-specific config (merchant/affiliate id, api key, ...)
  -- as one JSON blob, encrypted as a unit — new fields per provider don't
  -- need a schema migration, just a different JSON shape.
  config_ciphertext TEXT NOT NULL,
  config_iv TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, provider)
);

-- Unified in-flight payment tracking — cash, SumUp, and Bancontact all share
-- this one table now (previously: SumUp used a Durable Object, Bancontact
-- tracked nothing server-side at all, the browser polled Bancontact's API
-- directly). Every method resolves the same way: a provider callback
-- (primary) or the ChargePoller DO's periodic fallback sweep (poll +
-- time-out backstop), both funnelling through resolveCharge() in
-- payments/charges.ts. org_id is required from day one — no pre-org-scoping
-- legacy rows exist for this table.
CREATE TABLE IF NOT EXISTS charges (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  method TEXT NOT NULL, -- 'cash' | 'sumup' | 'bancontact'
  status TEXT NOT NULL, -- 'pending' | 'succeeded' | 'failed'
  -- Raw provider status string (e.g. Bancontact's AUTHORIZED/IDENTIFIED/...),
  -- display-only — `status` above is what business logic/the poller act on.
  provider_status TEXT,
  amount_cents INTEGER NOT NULL,
  description TEXT,
  pos_terminal_id TEXT,
  items TEXT, -- JSON
  slot_id TEXT,
  device_id TEXT,
  device_name TEXT,
  user_name TEXT,
  user_email TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  transaction_code TEXT,
  error_message TEXT,
  -- The provider's own id for this charge (SumUp reader checkout_id,
  -- Bancontact paymentId) — used by the poller to ask the provider for
  -- status. Not used to correlate an incoming callback for either provider:
  -- SumUp's callback URL embeds our own id+token directly, Bancontact's
  -- payload echoes back `reference`, which we set to our own id.
  provider_ref TEXT,
  -- Whatever's provider-specific and doesn't warrant its own column (SumUp's
  -- target readerId + a random per-charge callback token; nothing yet for
  -- Bancontact) — JSON, so a future provider doesn't need a migration.
  provider_data TEXT,
  -- Provider-supplied expiry when known (Bancontact's expiresAt); NULL means
  -- "use the platform default" in the poller's time-out backstop.
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_charges_org ON charges(org_id);
CREATE INDEX IF NOT EXISTS idx_charges_status ON charges(status);
CREATE INDEX IF NOT EXISTS idx_charges_method_provider_ref ON charges(method, provider_ref);
