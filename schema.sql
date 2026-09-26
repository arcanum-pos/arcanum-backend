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
  -- Set for sales paid through a tab (see tabs.ts) — every kassa sale from
  -- migration 0012 on. NULL for rows recorded before tabs existed.
  tab_id TEXT REFERENCES tabs(id),
  -- Part of amount_cents, not revenue (step 3d). 0 for everything before tips.
  tip_cents INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_completed_at ON transactions(completed_at);
CREATE INDEX IF NOT EXISTS idx_transactions_slot_id ON transactions(slot_id);
CREATE INDEX IF NOT EXISTS idx_transactions_org_id ON transactions(org_id);
CREATE INDEX IF NOT EXISTS idx_transactions_event_id ON transactions(event_id);
CREATE INDEX IF NOT EXISTS idx_transactions_tab_id ON transactions(tab_id);

-- The `devices` table used to live here; it moved to arcanum-devicehub's own
-- D1 database (arcanum-devices) so the two Workers don't share a database.

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
  created_by_sub TEXT NOT NULL,
  -- Optional custom domain, registered with Cloudflare's Custom Hostnames
  -- API against the kaboutersoft.be zone — see organizations/custom-domain.ts.
  -- Setting one requires this org to already have a complete identity_providers
  -- row of its own (enforced in custom-domain.ts's setCustomDomain): custom
  -- domain and own identity provider are a mandatory pair, since login links
  -- carry no org identifier at all (see identity-providers.ts) — Host header
  -- is the only thing that can tell such an org apart from the shared default.
  -- custom_domain_cf_id is Cloudflare's own hostname id (needed to poll/
  -- delete it); status/ssl_status mirror Cloudflare's `status`/`ssl.status`,
  -- refreshed only on an explicit Verify, not polled in the background.
  -- custom_domain_route_id is the exact-hostname Workers Route id created
  -- alongside it (never a zone-wide wildcard — see custom-domain.ts).
  custom_domain TEXT,
  custom_domain_cf_id TEXT,
  custom_domain_route_id TEXT,
  custom_domain_status TEXT,
  custom_domain_ssl_status TEXT,
  -- Set only while this org is being imported from an export file (see
  -- org-transfer.ts): 'importing', the id-remapping key, and the expected
  -- row counts. Cleared by /import/finish.
  import_status TEXT,
  import_key TEXT,
  import_manifest TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_custom_domain ON organizations(custom_domain);

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
  -- Overrides the hardcoded 'openid profile email offline_access' scope
  -- string sent at login/device-flow time — see migrations/0007_idp_scopes.sql
  -- for why (not every provider accepts 'offline_access'). NULL uses the
  -- default.
  scopes TEXT,
  -- Optional override client for the authorization-code flow only (browser
  -- /login and /:orgId/console) — device grant always uses client_id above.
  -- See migrations/0008_auth_code_client.sql for why (Google requires a
  -- separate OAuth client per flow; Auth0 doesn't).
  auth_code_client_id TEXT,
  auth_code_client_secret_ciphertext TEXT,
  auth_code_client_secret_iv TEXT,
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
  expires_at TEXT,
  -- The tab this payment settles (see tabs.ts). NULL for charges created
  -- before tabs existed.
  tab_id TEXT REFERENCES tabs(id),
  -- Part of amount_cents (the customer pays it in the same payment), never
  -- counted toward the tab's paid amount — see tabs.ts PAID_SQL.
  tip_cents INTEGER NOT NULL DEFAULT 0,
  -- Which part of the tab's "Gelijk verdelen" plan this pays (1-based; 0 = not a part) (0018).
  split_part INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_charges_org ON charges(org_id);
-- At most one in-flight payment per tab — the actual guard against two
-- kassas paying the same tab at once (a second pending insert fails).
CREATE UNIQUE INDEX IF NOT EXISTS idx_charges_one_pending_per_tab ON charges(tab_id) WHERE status = 'pending' AND tab_id IS NOT NULL;

-- Which units of which order line a payment covers (split per item, 0019).
CREATE TABLE IF NOT EXISTS charge_lines (
  charge_id TEXT NOT NULL REFERENCES charges(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  tab_id TEXT NOT NULL REFERENCES tabs(id),
  line_id TEXT NOT NULL REFERENCES order_lines(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (charge_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_charge_lines_tab ON charge_lines(tab_id);
CREATE INDEX IF NOT EXISTS idx_charge_lines_line ON charge_lines(line_id);
CREATE INDEX IF NOT EXISTS idx_charges_status ON charges(status);
CREATE INDEX IF NOT EXISTS idx_charges_method_provider_ref ON charges(method, provider_ref);

-- --- Tabs / orders (see tabs.ts, DOMAIN_MODEL.md) ---

-- Per-org sequences: 'tab' (display number, gaps allowed) and 'receipt'
-- (gapless — only ever incremented in the same batch that closes a tab, see
-- tabs.ts's settleTab).
CREATE TABLE IF NOT EXISTS org_counters (
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (org_id, name)
);

CREATE TABLE IF NOT EXISTS tabs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  number INTEGER NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'cancelled')),
  slot_id TEXT,
  event_id TEXT REFERENCES events(id),
  opened_device_id TEXT,
  opened_device_name TEXT,
  opened_by_name TEXT,
  opened_by_email TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  receipt_number INTEGER,
  cancel_reason TEXT,
  -- "Gelijk verdelen": what was open divided over split_parts; split_paid of them paid (0018).
  split_parts INTEGER,
  split_paid INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tabs_org_number ON tabs(org_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tabs_org_receipt ON tabs(org_id, receipt_number);
CREATE INDEX IF NOT EXISTS idx_tabs_org_status ON tabs(org_id, status);

-- One round of lines submitted together. Append-only.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  tab_id TEXT NOT NULL REFERENCES tabs(id),
  source TEXT NOT NULL, -- 'kassa' (later: 'waiter' | 'self_order')
  catalog_id TEXT REFERENCES catalogs(id), -- set when the order has catalog-priced lines
  device_id TEXT,
  device_name TEXT,
  user_name TEXT,
  user_email TEXT,
  submitted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_tab ON orders(tab_id);

-- Append-only: a correction is a new line with negative quantity pointing
-- at the original (voids_line_id) plus a reason, never an edit or delete.
-- name/unit_price_cents/category/vat are copied in at sale time, so history
-- never depends on the catalog. item_code is the legacy hardcoded item key
-- (bon, fietstocht, ..., fooi) until the catalog exists; variant_id is NULL
-- until then.
CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  tab_id TEXT NOT NULL REFERENCES tabs(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  item_code TEXT,
  variant_id TEXT,
  name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  category TEXT,
  vat_rate_bp INTEGER, -- basis points (2100 = 21%); NULL until the catalog sets it
  -- The product's prep station at sale time (snapshot, no foreign key).
  prep_station_id TEXT,
  prep_station_name TEXT,
  note TEXT,
  voids_line_id TEXT REFERENCES order_lines(id),
  void_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_lines_tab ON order_lines(tab_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_voids ON order_lines(voids_line_id);

-- --- Catalog (see catalog.ts, DOMAIN_MODEL.md) ---

-- Categories: what a product *is* (Drank, Eten, Inschrijvingen) — for
-- reporting now, prep-station routing later. Org-level, shared by every
-- catalog.
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_categories_org ON categories(org_id);

-- Products are defined once per org; price lives on the catalog entry, not
-- here. Archived, never deleted — order_lines reference their variants.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  category_id TEXT REFERENCES categories(id),
  name TEXT NOT NULL,
  vat_rate_bp INTEGER, -- basis points (2100 = 21%); NULL = not set yet
  -- Who prepares it (Bar, Keuken, …); NULL = nothing to prepare.
  prep_station_id TEXT REFERENCES prep_stations(id),
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_org ON products(org_id);

-- Every product has >= 1 variant (a single-version product has one with an
-- empty name). `code` is the "typ een code" / later barcode key, and for
-- the seeded legacy items the old transactions.items key (bon,
-- fietstochtMember, ...), so reports keep working until they move to
-- order_lines.
CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL DEFAULT '',
  code TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_org_code ON product_variants(org_id, code) WHERE code IS NOT NULL AND archived_at IS NULL;

-- A selection of variants with a price each, plus the kassa layout
-- (sections). Independent of events (DOMAIN_MODEL.md decision 1). Exactly
-- one default per org — what a kassa sells from unless the device picks
-- another.
CREATE TABLE IF NOT EXISTS catalogs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalogs_org ON catalogs(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalogs_one_default ON catalogs(org_id) WHERE is_default = 1;

-- Button page/group on the kassa — this *is* the layout.
CREATE TABLE IF NOT EXISTS catalog_sections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  catalog_id TEXT NOT NULL REFERENCES catalogs(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_catalog_sections_catalog ON catalog_sections(catalog_id);

-- One variant at most once per catalog, with its price there. Deletable
-- (history is copied into order_lines). quick_quantities: optional JSON
-- array of "sell N at once" buttons (e.g. [5,10,...] bonnen).
CREATE TABLE IF NOT EXISTS catalog_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  catalog_id TEXT NOT NULL REFERENCES catalogs(id),
  section_id TEXT NOT NULL REFERENCES catalog_sections(id),
  variant_id TEXT NOT NULL REFERENCES product_variants(id),
  price_cents INTEGER NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  quick_quantities TEXT
);

CREATE INDEX IF NOT EXISTS idx_catalog_entries_section ON catalog_entries(section_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_entries_catalog_variant ON catalog_entries(catalog_id, variant_id);

-- Prep stations: who prepares a product (Bar, Keuken, CoffeeCorner, …) —
-- separate from categories (reporting) and catalog sections (kassa layout).
CREATE TABLE IF NOT EXISTS prep_stations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prep_stations_org ON prep_stations(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prep_stations_org_name ON prep_stations(org_id, lower(name));

-- --- Migration tracking ---
-- wrangler's own table (`wrangler d1 migrations apply`), with the exact DDL
-- wrangler uses. A database built from this file already contains every
-- migration's effect, so all of them are marked as applied; test/
-- installation.test.ts checks this list matches migrations/ and that this
-- file really contains what the migrations add. A new migration = the new
-- migrations/NNNN_*.sql file + the same change here + one line below.
CREATE TABLE IF NOT EXISTS d1_migrations(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_add_org_support.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_multi_issuer_identity.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0003_smtp_credentials.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0004_events.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0005_org_slug.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0006_mail_provider.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0007_idp_scopes.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0008_auth_code_client.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0009_custom_domain.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0010_custom_domain_route.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0011_drop_org_slug.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0012_tabs.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0013_catalog.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0014_order_catalog.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0015_tips.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0016_prep_stations.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0017_org_import.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0018_split_payments.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0019_charge_lines.sql');
