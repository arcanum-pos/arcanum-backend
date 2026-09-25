-- Prep stations: who prepares a product (Bar, Keuken, CoffeeCorner, …) —
-- separate from categories (reporting) and catalog sections (kassa layout).
-- A product has an optional station (NULL = nothing to prepare, e.g.
-- bonnen); every order line copies it at sale time, like name/price/
-- category, so prep tickets and history survive later changes. See
-- catalog.ts and tabs.ts.
-- Run once via:
--   wrangler d1 execute arcanum-backend --remote --file=migrations/0016_prep_stations.sql
CREATE TABLE IF NOT EXISTS prep_stations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prep_stations_org ON prep_stations(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prep_stations_org_name ON prep_stations(org_id, lower(name));

ALTER TABLE products ADD COLUMN prep_station_id TEXT REFERENCES prep_stations(id);
-- Snapshot, deliberately without a foreign key: a station that was used in
-- the past can still be deleted once no product points to it.
ALTER TABLE order_lines ADD COLUMN prep_station_id TEXT;
ALTER TABLE order_lines ADD COLUMN prep_station_name TEXT;
