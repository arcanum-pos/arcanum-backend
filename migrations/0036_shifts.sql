-- Registers, shifts and kasopmaak (DOMAIN_MODEL.md, release B2). A register
-- is a cash drawer ("Toog"), shared by the kassas that picked it; a shift is
-- its drawer from "Kassa openen" to "Kasopmaak". A kassa without a register
-- sells as before, outside any shift.
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

-- The shift a payment was made in (money belongs to the shift it was paid in).
ALTER TABLE charges ADD COLUMN shift_id TEXT;
ALTER TABLE transactions ADD COLUMN shift_id TEXT;
CREATE INDEX IF NOT EXISTS idx_charges_shift ON charges(shift_id);

-- Blind count: the expected cash shows only after the count is entered.
ALTER TABLE organizations ADD COLUMN blind_count INTEGER NOT NULL DEFAULT 0;
