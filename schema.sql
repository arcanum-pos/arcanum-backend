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
  completed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_completed_at ON transactions(completed_at);
CREATE INDEX IF NOT EXISTS idx_transactions_slot_id ON transactions(slot_id);
