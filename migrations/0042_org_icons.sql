-- An organisation's own app icons (2026-10-18, console → Instellingen →
-- Weergave → App-iconen): per page that can be installed as an app (`slot`:
-- kassa, display, station, pickup, entrance, tap, waiter, selforder, or
-- station-<prep station id>), the PNG in each size the browsers ask for —
-- made in the browser at upload. No row: the default icon (arcanum-bff).
CREATE TABLE IF NOT EXISTS org_icons (
  org_id TEXT NOT NULL REFERENCES organizations(id),
  slot TEXT NOT NULL,
  size INTEGER NOT NULL,
  png TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, slot, size)
);
