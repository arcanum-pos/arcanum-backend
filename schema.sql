-- Per-org events (see organizations/events.ts) — will drive what a kassa
-- shows (menu/catalogue) for a given event once that part is built; for
-- now, just name + date, and something transactions can be tagged with.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  event_date TEXT NOT NULL, -- ISO date, YYYY-MM-DD
  created_at TEXT NOT NULL,
  -- Self-ordering (migration 0025): the event's menu, on/off, the code in
  -- its public URL/QR, and its own short order numbers (resettable to 1).
  catalog_id TEXT REFERENCES catalogs(id),
  self_order_enabled INTEGER NOT NULL DEFAULT 0,
  self_order_code TEXT,
  order_counter INTEGER NOT NULL DEFAULT 0,
  -- How guests may pay (migration 0026): at the counter and/or with Bancontact.
  self_order_pay_counter INTEGER NOT NULL DEFAULT 1,
  self_order_pay_bancontact INTEGER NOT NULL DEFAULT 0,
  -- Guests may keep ordering on their tab and pay when they leave (migration 0027).
  self_order_tabs INTEGER NOT NULL DEFAULT 0,
  -- Since migration 0028, catalog_id, self_order_pay_counter,
  -- self_order_pay_bancontact and self_order_tabs are read no more: they're
  -- per ordering mode (event_order_modes).
  -- The readable self-order link, <name>-<4 characters> (migration 0030).
  self_order_slug TEXT,
  -- The kassa labels new orders with one of the ordering modes (migration 0032).
  kassa_modes INTEGER NOT NULL DEFAULT 0,
  -- The customer display's colours for this event (migration 0044); NULL:
  -- the organisation's (org_branding).
  brand_primary TEXT,
  brand_accent TEXT,
  -- Its last day, included (migration 0045); NULL: one day, event_date.
  end_date TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_org ON events(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_self_order_code ON events(self_order_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_self_order_slug ON events(self_order_slug);

-- An event's ordering modes (bestelwijzen, migration 0028): "Ter plaatse",
-- "Take away", "Alleen aan de kassa", … — each its own menu, where it's used
-- (the event's QR and/or the kassa), how guests pay, ordering on a tab.
-- Information on an order (a badge), never routing.
CREATE TABLE IF NOT EXISTS event_order_modes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  catalog_id TEXT REFERENCES catalogs(id),
  self_order INTEGER NOT NULL DEFAULT 0,
  -- Read no more since migration 0032 (one switch per event: events.kassa_modes).
  kassa INTEGER NOT NULL DEFAULT 1,
  pay_counter INTEGER NOT NULL DEFAULT 1,
  pay_bancontact INTEGER NOT NULL DEFAULT 0,
  tabs INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- An SMS when a station's part is ready (migration 0029, MESSAGING.md).
  notify_sms INTEGER NOT NULL DEFAULT 0,
  -- Opening a tab asks a name and a mobile number or e-mail (migration 0031).
  tab_contact INTEGER NOT NULL DEFAULT 0,
  -- Used at the table by waiters: its menu is theirs (migration 0037).
  at_table INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_event_order_modes_event ON event_order_modes(event_id, position);

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
  completed_at TEXT NOT NULL,
  -- Who handled the payment (migration 0035).
  staff_id TEXT,
  staff_name TEXT,
  -- The shift it was paid in (migration 0036).
  shift_id TEXT
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
  -- The former per-org custom domain (Cloudflare for SaaS, migrations 0009/
  -- 0010), removed from the code in hosting-plan phase 6 — a custom domain
  -- now belongs to the instance (the installer). Kept, unused, rather than
  -- dropped: arcanum-cleaner still skips an org that has a custom_domain.
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
  import_manifest TEXT,
  -- Default language (see organizations/locale.ts): the org's screens and
  -- the mails it sends, until a user picks their own.
  locale TEXT NOT NULL DEFAULT 'nl' CHECK (locale IN ('nl', 'fr', 'en')),
  -- 'N' = arcanum-cleaner deletes this org (every row of it) once it's 4 hours
  -- old; any other value, NULL included, keeps it (migration 0022).
  is_locked TEXT,
  -- A person must be chosen to sell (migration 0035).
  staff_required INTEGER NOT NULL DEFAULT 0,
  -- Receipts on a printer (migration 0049): off until switched on.
  receipts_enabled INTEGER NOT NULL DEFAULT 0,
  -- Kasopmaak: the expected cash only after the count (migration 0036).
  blind_count INTEGER NOT NULL DEFAULT 0
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
  role TEXT NOT NULL, -- 'admin' | 'cashier' | 'waiter' (Bediening, release C)
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
  -- seed time (see src/organizations/idp-resolution.ts) — never re-fetched
  -- at login time. Since hosting-plan phase 6 only the org_id = 'default'
  -- row (the instance's login provider) is used.
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
  split_part INTEGER NOT NULL DEFAULT 0,
  -- Who handled the payment (migration 0035).
  staff_id TEXT,
  staff_name TEXT,
  -- The shift it was paid in (migration 0036).
  shift_id TEXT
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
-- A tab's charges by tab (tab summaries: paid amount, methods) — migration 0021.
CREATE INDEX IF NOT EXISTS idx_charges_tab_status ON charges(tab_id, status);

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
  split_paid INTEGER NOT NULL DEFAULT 0,
  -- Migration 0025: the short number within its event, where it came from
  -- ('kassa' | 'self_order'), the token of its "follow your order" page.
  event_number INTEGER,
  source TEXT NOT NULL DEFAULT 'kassa',
  order_token TEXT,
  -- A self-order tab paid when the guest leaves (migration 0027): never
  -- cancelled for being unpaid; its orders go to the stations unpaid.
  pay_later INTEGER NOT NULL DEFAULT 0,
  -- The ordering mode it came in by (migration 0028), its name a snapshot.
  order_mode_id TEXT,
  order_mode_name TEXT,
  -- The guest's number for "ready" SMS (migration 0029), kept only while needed.
  notify_phone TEXT,
  -- A guest's browser push subscription, until the order is ready (migration 0039).
  push_subscription TEXT,
  -- Who's behind a guest's tab (migration 0031), kept only while it's open.
  contact_phone TEXT,
  contact_email TEXT,
  -- Who opened it, on a shared device (migration 0035).
  staff_id TEXT,
  staff_name TEXT,
  -- The table it's on (migration 0037, release C).
  table_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tabs_org_number ON tabs(org_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tabs_order_token ON tabs(order_token);
CREATE INDEX IF NOT EXISTS idx_tabs_event_status ON tabs(event_id, status);
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
  submitted_at TEXT NOT NULL,
  -- Who took it (migration 0035).
  staff_id TEXT,
  staff_name TEXT
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
  position INTEGER NOT NULL DEFAULT 0,
  -- The kassa's colour for it, one of its palette (migration 0046); NULL: automatic.
  color TEXT
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
  created_at TEXT NOT NULL,
  -- Which printer prints its tickets (migration 0047; none: not printed).
  printer_id TEXT REFERENCES printers(id)
);

CREATE INDEX IF NOT EXISTS idx_prep_stations_org ON prep_stations(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prep_stations_org_name ON prep_stations(org_id, lower(name));

-- Device pairing (migration 0023, DOMAIN_MODEL.md "Devices: control plane
-- and data plane"): a device is registered only by claiming a code an admin
-- made in the console. Only the code's SHA-256 is stored; rows kept 30 days.
CREATE TABLE IF NOT EXISTS device_pairings (
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
  -- A customer display's kassa, linked on claim (migration 0024).
  link_to TEXT,
  -- A station screen's station (migration 0025).
  station_id TEXT,
  -- A station screen's kind (migration 0034): NULL = prep, 'pickup' = for guests.
  view TEXT,
  -- A re-pair code (migration 0041): the existing device it makes a browser again.
  repairs TEXT
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

-- Prep tickets (migration 0025): the part of one order that goes to one
-- station, with its status: ordered → in_progress → ready → delivered.
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
  updated_by TEXT,
  -- Its "ready" SMS (migration 0029): sending | sent | failed | capped.
  sms_status TEXT,
  -- Its Web Push notification: sending | sent | failed (migration 0039).
  push_status TEXT,
  -- Who's making it, since when (migration 0035).
  claimed_by_staff_id TEXT,
  claimed_by_name TEXT,
  claimed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_prep_tickets_station ON prep_tickets(org_id, station_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prep_tickets_tab ON prep_tickets(tab_id);

-- Every "ready" SMS attempt (migration 0029, MESSAGING.md): for the
-- installation's daily maximum (rolling 24 hours) and to see what failed.
-- No phone numbers.
CREATE TABLE IF NOT EXISTS sms_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ticket_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  provider_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_log_created ON sms_log(created_at);

-- Which station a station screen (device role 'station') shows (migration 0025).
-- A station screen's or customer display's own key (migration 0033): paired
-- with its code alone, no person signed in; only its SHA-256 stored; valid
-- until the device is removed.
CREATE TABLE IF NOT EXISTS device_keys (
  key_hash TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('station', 'cfd', 'tap')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_keys_terminal ON device_keys(terminal_id);

-- A device's Web Push subscription (migration 0040): a kassa's Tap to Pay
-- phone gets "€12,50 aan de kassa" while it's locked. Gone with the device.
CREATE TABLE IF NOT EXISTS device_push_subscriptions (
  terminal_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  subscription TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Which pairing a device is now (migration 0041): after a re-pair, a browser
-- that was the device before stops being it. No row: not checked.
CREATE TABLE IF NOT EXISTS device_claims (
  terminal_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  pairing_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);

-- An organisation's own app icons (migration 0042): per slot (kassa,
-- display, station, pickup, entrance, tap, waiter, selforder, station-<id>)
-- the PNG (base64) per size. No row: the default icon.
CREATE TABLE IF NOT EXISTS org_icons (
  org_id TEXT NOT NULL REFERENCES organizations(id),
  slot TEXT NOT NULL,
  size INTEGER NOT NULL,
  png TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, slot, size)
);

-- The customer display's branding (migration 0044): the organisation's
-- logo (PNG, base64) and its main and accent colour (#rrggbb).
CREATE TABLE IF NOT EXISTS org_branding (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  primary_color TEXT,
  accent_color TEXT,
  logo_png TEXT,
  logo_updated_at TEXT,
  updated_at TEXT NOT NULL
);

-- What a kassa's customer display shows while the order is being entered
-- (migration 0043): the kassa's current order (JSON), `seq` its own counter.
CREATE TABLE IF NOT EXISTS customer_views (
  terminal_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  view TEXT,
  seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS station_devices (
  terminal_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  station_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- NULL = the prep screen, 'pickup' = the pickup screen for guests (migration 0034).
  view TEXT
);

-- Staff on shared devices (migration 0035, DOMAIN_MODEL.md release B1):
-- a name and an optional PIN, to record who did what.
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  pin_hash TEXT,
  pin_changed_at TEXT,
  member_id TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_org ON staff(org_id);
CREATE TABLE IF NOT EXISTS staff_pin_failures (
  caller TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_pin_failures ON staff_pin_failures(caller, at);

-- Registers, shifts and kasopmaak (migration 0036, DOMAIN_MODEL.md release B2).
CREATE TABLE IF NOT EXISTS registers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_registers_org ON registers(org_id);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  register_id TEXT NOT NULL REFERENCES registers(id),
  -- Per organisation, counting up (like tabs).
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at TEXT NOT NULL,
  opened_by_name TEXT,
  opened_by_staff_name TEXT,
  opening_float_cents INTEGER NOT NULL,
  -- Per denomination (cents → count), when counted that way.
  opening_count TEXT,
  closed_at TEXT,
  closed_by_name TEXT,
  closed_by_staff_name TEXT,
  counted_cents INTEGER,
  closing_count TEXT,
  -- Snapshotted at close (the cash formula), and the per-method totals.
  expected_cents INTEGER,
  difference_cents INTEGER,
  totals TEXT,
  note TEXT,
  -- What stays in the drawer: the next shift's suggested float.
  left_in_drawer_cents INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shifts_org ON shifts(org_id, opened_at);
-- At most one open shift per register.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open ON shifts(register_id) WHERE status = 'open';

-- Cash in (extra change) and out (to the safe, a paid-out) during a shift.
CREATE TABLE IF NOT EXISTS cash_movements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  device_name TEXT,
  user_name TEXT,
  staff_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_movements_shift ON cash_movements(shift_id);

CREATE INDEX IF NOT EXISTS idx_charges_shift ON charges(shift_id);

-- Tables (migration 0037, DOMAIN_MODEL.md release C).
CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  zone TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  -- In the table's QR code (/tafel/<token>): random, not guessable; made
  -- when first needed (none after an import: another installation's link).
  qr_token TEXT,
  -- The last "Opgeruimd": a table is Vrij when its last tab closed before this.
  cleared_at TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  -- Guests moved away or joined another table: Af te ruimen (migration 0038).
  needs_clearing_at TEXT,
  -- Promised to guests waiting at the entrance (migration 0038).
  promised_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tables_org ON tables(org_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_qr ON tables(qr_token) WHERE qr_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tabs_one_open_per_table ON tabs(table_id) WHERE status = 'open' AND table_id IS NOT NULL;

-- Ticket printers (2026-10-28, arcanum/PRINTING.md): a printer is a device
-- of the org, managed in the console under Toestellen. Epson first; push
-- = a screen on the printer's network sends to host:port (ePOS-Print),
-- poll = the printer asks Arcanum (Server Direct Print, phase 3).
CREATE TABLE IF NOT EXISTS printers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  brand TEXT NOT NULL CHECK (brand IN ('epson', 'star')),
  connection TEXT NOT NULL CHECK (connection IN ('push', 'poll')),
  host TEXT,
  port INTEGER,
  -- ePOS-Print's device id: local_printer is the printer itself.
  device_id TEXT NOT NULL DEFAULT 'local_printer',
  paper_mm INTEGER NOT NULL DEFAULT 80 CHECK (paper_mm IN (58, 80)),
  created_at TEXT NOT NULL,
  -- Polling (migration 0048): the secret in its URL (SHA-256), how often it
  -- asks, when it last asked (written at most once a minute).
  poll_key_hash TEXT,
  poll_interval INTEGER NOT NULL DEFAULT 10,
  last_poll_at TEXT,
  -- The same secret encrypted under the org's data key, to show its URL
  -- again (migration 0050).
  poll_key_ciphertext TEXT,
  poll_key_iv TEXT
);
CREATE INDEX IF NOT EXISTS idx_printers_org ON printers(org_id);

-- One thing to print on one printer, printed exactly once: waiting ->
-- claimed (one conditional UPDATE: of several screens, or the printer
-- itself, exactly one wins) -> printed or failed. A claim not reported
-- within 30 s is claimable again. `document` is the ePOS-Print XML.
CREATE TABLE IF NOT EXISTS print_jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  printer_id TEXT NOT NULL REFERENCES printers(id),
  kind TEXT NOT NULL CHECK (kind IN ('ticket', 'receipt', 'test')),
  -- What it prints: a prep ticket's id (a ticket is queued once), a tab's.
  ref_id TEXT,
  title TEXT NOT NULL,
  document TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'claimed', 'printed', 'failed')),
  claim_token TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_print_jobs_ticket ON print_jobs(ref_id) WHERE kind = 'ticket';
CREATE INDEX IF NOT EXISTS idx_print_jobs_printer ON print_jobs(printer_id, status, created_at);

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
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0020_org_locale.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0021_charges_tab_index.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0022_org_is_locked.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0023_device_pairings.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0024_device_pairing_link.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0025_self_order.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0026_self_order_payment.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0027_self_order_tabs.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0028_order_modes.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0029_sms.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0030_self_order_link.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0031_tab_contact.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0032_kassa_modes.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0033_device_keys.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0034_pickup_screens.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0035_staff.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0036_shifts.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0037_tables.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0038_table_management.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0039_web_push.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0040_tap_devices.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0041_device_repair.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0042_org_icons.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0043_customer_views.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0044_branding.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0045_event_end_date.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0046_section_color.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0047_printers.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0048_printer_polling.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0049_receipts.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0050_printer_poll_link.sql');
