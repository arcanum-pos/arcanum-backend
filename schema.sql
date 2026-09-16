-- Per-org events (see organizations/events.ts) — will drive what a kassa
-- shows (menu/catalogue) for a given event once that part is built; for
-- now, just name + date, and something transactions can be tagged with.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  event_date TEXT NOT NULL, -- ISO date, YYYY-MM-DD
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_org ON events(org_id);

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
  -- Nullable: nothing assigns this yet (that needs the kassa to know which
  -- event is active, a later step) — the column exists now so that step
  -- doesn't need its own migration.
  event_id TEXT REFERENCES events(id),
  completed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_completed_at ON transactions(completed_at);
CREATE INDEX IF NOT EXISTS idx_transactions_slot_id ON transactions(slot_id);
CREATE INDEX IF NOT EXISTS idx_transactions_org_id ON transactions(org_id);
CREATE INDEX IF NOT EXISTS idx_transactions_event_id ON transactions(event_id);

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
  -- Optional, admin-settable short identifier (see organizations.ts's
  -- SLUG_RE) so device/login links can read e.g. "/scouts-elewijt/device"
  -- instead of the raw id. Nullable — a NULL slug never conflicts with
  -- another NULL under SQLite's unique-index semantics, so orgs without
  -- one just keep using their UUID.
  slug TEXT,
  -- Envelope encryption: this org's own AES-256 data key, wrapped (encrypted)
  -- with the platform-wide ENCRYPTION_KEY secret. Never stored unwrapped.
  dek_ciphertext TEXT NOT NULL,
  dek_iv TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_sub TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_sub TEXT,
  -- Which issuer authenticated this user_sub — a bare sub is only unique
  -- within the issuer that minted it, and once an org can bring its own IdP,
  -- trusting a bare sub platform-wide (e.g. listMyOrganizations/
  -- listMyMemberships, which query across every org) is a cross-tenant
  -- impersonation path. NULL only for rows predating multi-issuer support.
  issuer TEXT,
  invited_email TEXT NOT NULL,
  role TEXT NOT NULL, -- 'admin' | 'cashier'
  status TEXT NOT NULL, -- 'pending' | 'active'
  invited_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user_sub ON memberships(user_sub);
CREATE INDEX IF NOT EXISTS idx_memberships_issuer_sub ON memberships(issuer, user_sub);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_org_email ON memberships(org_id, invited_email);

CREATE TABLE IF NOT EXISTS identity_providers (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  connection_name TEXT,
  issuer_url TEXT,
  client_id TEXT,
  client_secret_ciphertext TEXT,
  client_secret_iv TEXT,
  -- Resolved once from issuer_url's /.well-known/openid-configuration at
  -- admin-save time (see worker/src/organizations/idp-resolution.ts) — never
  -- re-fetched at login time, so a login never depends on a live discovery
  -- fetch to an arbitrary org-run identity provider.
  authorization_endpoint TEXT,
  token_endpoint TEXT,
  userinfo_endpoint TEXT,
  device_authorization_endpoint TEXT,
  end_session_endpoint TEXT,
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

-- Per-org outbound email account (see organizations/smtp-credentials.ts) —
-- an org that hasn't set its own falls back to the 'default' org's config,
-- same pattern as identity_providers. Plain columns for everything but the
-- password (shown back to the admin for editing, like identity_providers'
-- issuer_url/client_id), one encrypted column pair for the password itself.
CREATE TABLE IF NOT EXISTS smtp_credentials (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  host TEXT,
  port INTEGER,
  username TEXT,
  password_ciphertext TEXT,
  password_iv TEXT,
  from_address TEXT,
  from_name TEXT,
  updated_at TEXT NOT NULL
);

-- Which outbound mail transport an org uses — 'smtp' (smtp_credentials,
-- above) or 'gmail_api' (gmail_api_credentials, below). No row means
-- 'smtp', so this never needs backfilling for existing orgs. See
-- organizations/mail-provider.ts.
CREATE TABLE IF NOT EXISTS mail_provider (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  provider TEXT NOT NULL DEFAULT 'smtp' CHECK (provider IN ('smtp', 'gmail_api')),
  updated_at TEXT NOT NULL
);

-- A domain-wide-delegated Google service account: client_email +
-- private_key sign a JWT impersonating impersonated_user, exchanged for an
-- OAuth2 token, then used to call the Gmail API directly — no SMTP socket,
-- no DNS/SPF/DKIM changes needed, since it's Google's own already-
-- authorized first-party sending path for the domain. See
-- organizations/gmail-api-credentials.ts.
CREATE TABLE IF NOT EXISTS gmail_api_credentials (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  client_email TEXT,
  private_key_ciphertext TEXT,
  private_key_iv TEXT,
  impersonated_user TEXT,
  from_name TEXT,
  updated_at TEXT NOT NULL
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
