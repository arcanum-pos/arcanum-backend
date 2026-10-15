-- Staff on shared devices (DOMAIN_MODEL.md, release B1): a name and an
-- optional PIN, to record who did what on a shared kassa or station screen.
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  pin_hash TEXT,
  -- Tokens issued before this no longer count (a new or removed PIN).
  pin_changed_at TEXT,
  -- The same person's account membership, when they have one.
  member_id TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_org ON staff(org_id);

-- Wrong PINs, per device or person, for the per-minute limit.
CREATE TABLE IF NOT EXISTS staff_pin_failures (
  caller TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_pin_failures ON staff_pin_failures(caller, at);

-- An organisation may require a person to be chosen to sell (S2).
ALTER TABLE organizations ADD COLUMN staff_required INTEGER NOT NULL DEFAULT 0;

-- Who did it, next to the account and device already recorded.
ALTER TABLE tabs ADD COLUMN staff_id TEXT;
ALTER TABLE tabs ADD COLUMN staff_name TEXT;
ALTER TABLE orders ADD COLUMN staff_id TEXT;
ALTER TABLE orders ADD COLUMN staff_name TEXT;
ALTER TABLE charges ADD COLUMN staff_id TEXT;
ALTER TABLE charges ADD COLUMN staff_name TEXT;
ALTER TABLE transactions ADD COLUMN staff_id TEXT;
ALTER TABLE transactions ADD COLUMN staff_name TEXT;

-- Who's making a ticket (Start on the station screen), and since when.
ALTER TABLE prep_tickets ADD COLUMN claimed_by_staff_id TEXT;
ALTER TABLE prep_tickets ADD COLUMN claimed_by_name TEXT;
ALTER TABLE prep_tickets ADD COLUMN claimed_at TEXT;
