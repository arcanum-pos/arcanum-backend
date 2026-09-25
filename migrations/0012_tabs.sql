-- Tabs (rekeningen), orders (bestellingen) and order lines — step 1 of the
-- catalog/tab work, see DOMAIN_MODEL.md "Build order". A counter sale is a
-- tab that is paid immediately; a table/customer tab just stays open longer.
-- Run once via:
--   wrangler d1 execute arcanum-backend --remote --file=migrations/0012_tabs.sql

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
  cancel_reason TEXT
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
  note TEXT,
  voids_line_id TEXT REFERENCES order_lines(id),
  void_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_lines_tab ON order_lines(tab_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_voids ON order_lines(voids_line_id);

ALTER TABLE charges ADD COLUMN tab_id TEXT REFERENCES tabs(id);
-- At most one in-flight payment per tab — the actual guard against two
-- kassas paying the same tab at once (a second pending insert fails).
CREATE UNIQUE INDEX IF NOT EXISTS idx_charges_one_pending_per_tab ON charges(tab_id) WHERE status = 'pending' AND tab_id IS NOT NULL;

ALTER TABLE transactions ADD COLUMN tab_id TEXT REFERENCES tabs(id);
CREATE INDEX IF NOT EXISTS idx_transactions_tab_id ON transactions(tab_id);
