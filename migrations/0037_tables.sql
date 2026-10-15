-- Tables and waiters (DOMAIN_MODEL.md, release C). Tables belong to the
-- organisation (T1); a tab can be on one (one open tab per table, T5); its
-- status follows that tab — only "cleaned" (cleared_at) is set by hand.
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
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tables_org ON tables(org_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_qr ON tables(qr_token) WHERE qr_token IS NOT NULL;

ALTER TABLE tabs ADD COLUMN table_id TEXT;
-- One open tab per table (T5).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tabs_one_open_per_table ON tabs(table_id) WHERE status = 'open' AND table_id IS NOT NULL;

-- An ordering mode used at the table, by waiters (T2): its menu is theirs.
ALTER TABLE event_order_modes ADD COLUMN at_table INTEGER NOT NULL DEFAULT 0;
