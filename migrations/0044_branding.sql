-- The customer display's branding (2026-10-23, console → Instellingen →
-- Weergave → Klantscherm): the organisation's logo and two colours — a
-- main colour (header, total panel) and an accent (highlights). An event
-- can have colours of its own (a club's tournament vs. its quiz night);
-- unset, the organisation's. Only the customer display uses them.
CREATE TABLE IF NOT EXISTS org_branding (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  primary_color TEXT,   -- #rrggbb, or NULL: the display's own colours
  accent_color TEXT,
  logo_png TEXT,        -- base64; made in the browser (at most 512 px a side)
  logo_updated_at TEXT,
  updated_at TEXT NOT NULL
);
ALTER TABLE events ADD COLUMN brand_primary TEXT;
ALTER TABLE events ADD COLUMN brand_accent TEXT;
