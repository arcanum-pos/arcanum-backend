-- A menu group's colour on the kassa (2026-10-24, KASSA_REDESIGN.md phase 6):
-- one of the kassa's palette (catalog.ts SECTION_COLORS), chosen in the
-- console's menu editor. NULL: automatic, by the group's place in the menu.
ALTER TABLE catalog_sections ADD COLUMN color TEXT;
