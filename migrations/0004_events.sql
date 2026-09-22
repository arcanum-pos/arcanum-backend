-- One-time migration for the existing production `arcanum-backend` D1
-- database: adds per-org events and a way to tag transactions with one.
-- Run once via:
--   wrangler d1 execute arcanum-backend --remote --file=migrations/0004_events.sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  event_date TEXT NOT NULL, -- ISO date, YYYY-MM-DD
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_org ON events(org_id);

-- Nullable: nothing assigns this yet (needs the kassa to know which event
-- is active, a later step) — added now so that step doesn't need its own
-- migration.
ALTER TABLE transactions ADD COLUMN event_id TEXT REFERENCES events(id);
CREATE INDEX IF NOT EXISTS idx_transactions_event_id ON transactions(event_id);
