-- What a kassa's customer display shows while the order is being entered
-- (2026-10-18, customer-view.ts): the order on the kassa's screen right now,
-- per kassa, replaced on every change (`seq`: the kassa's own counter, so
-- an older one never overwrites a newer). Kept only while the kassa has a
-- customer display on another device; a same-device one gets it directly.
CREATE TABLE IF NOT EXISTS customer_views (
  terminal_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  view TEXT,
  seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
