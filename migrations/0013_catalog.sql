-- Catalogs — step 3a of the catalog/tab work (see DOMAIN_MODEL.md "Build
-- order" and "Step 3 decisions"): categories, products + variants
-- (org-level), catalogs with sections and priced entries. See catalog.ts.
-- Run once via:
--   wrangler d1 execute arcanum-backend --remote --file=migrations/0013_catalog.sql

-- Categories: what a product *is* (Drank, Eten, Inschrijvingen) — for
-- reporting now, prep-station routing later. Org-level, shared by every
-- catalog.
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_categories_org ON categories(org_id);

-- Products are defined once per org; price lives on the catalog entry, not
-- here. Archived, never deleted — order_lines reference their variants.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  category_id TEXT REFERENCES categories(id),
  name TEXT NOT NULL,
  vat_rate_bp INTEGER, -- basis points (2100 = 21%); NULL = not set yet
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_org ON products(org_id);

-- Every product has >= 1 variant (a single-version product has one with an
-- empty name). `code` is the "typ een code" / later barcode key, and for
-- the seeded legacy items the old transactions.items key (bon,
-- fietstochtMember, ...), so reports keep working until they move to
-- order_lines.
CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL DEFAULT '',
  code TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_org_code ON product_variants(org_id, code) WHERE code IS NOT NULL AND archived_at IS NULL;

-- A selection of variants with a price each, plus the kassa layout
-- (sections). Independent of events (DOMAIN_MODEL.md decision 1). Exactly
-- one default per org — what a kassa sells from unless the device picks
-- another.
CREATE TABLE IF NOT EXISTS catalogs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalogs_org ON catalogs(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalogs_one_default ON catalogs(org_id) WHERE is_default = 1;

-- Button page/group on the kassa — this *is* the layout.
CREATE TABLE IF NOT EXISTS catalog_sections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  catalog_id TEXT NOT NULL REFERENCES catalogs(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_catalog_sections_catalog ON catalog_sections(catalog_id);

-- One variant at most once per catalog, with its price there. Deletable
-- (history is copied into order_lines). quick_quantities: optional JSON
-- array of "sell N at once" buttons (e.g. [5,10,...] bonnen).
CREATE TABLE IF NOT EXISTS catalog_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  catalog_id TEXT NOT NULL REFERENCES catalogs(id),
  section_id TEXT NOT NULL REFERENCES catalog_sections(id),
  variant_id TEXT NOT NULL REFERENCES product_variants(id),
  price_cents INTEGER NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  quick_quantities TEXT
);

CREATE INDEX IF NOT EXISTS idx_catalog_entries_section ON catalog_entries(section_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_entries_catalog_variant ON catalog_entries(catalog_id, variant_id);

-- --- Seed: Scouts Elewijt's "Standaard" catalog ---
-- The one org selling today's hardcoded items. Prices are the live values
-- from the SETTINGS KV namespace on 2026-09-25 (bon 100, fietstocht
-- 800/500, wandeltocht 600/300). Variant codes are the legacy
-- transactions.items keys. Fixed ids + INSERT OR IGNORE + the org check
-- make this safe to re-run and a no-op on any database without that org
-- (local dev, tests).

INSERT OR IGNORE INTO categories (id, org_id, name, position, created_at)
  SELECT '5cd106cb-b960-4831-935e-eaeaab553d6b', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', 'Bonnen', 0, '2026-09-25T00:00:00.000Z'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO categories (id, org_id, name, position, created_at)
  SELECT '36e56b87-3158-4d2a-af0d-efb3187a4382', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', 'Inschrijvingen', 1, '2026-09-25T00:00:00.000Z'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO products (id, org_id, category_id, name, created_at)
  SELECT 'b3bd403b-81b6-4fc7-8f71-4fa663ae3f90', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '5cd106cb-b960-4831-935e-eaeaab553d6b', 'Bon', '2026-09-25T00:00:00.000Z'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO products (id, org_id, category_id, name, created_at)
  SELECT '3b00f42f-4efc-4ae1-8647-86249f0a9d08', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '36e56b87-3158-4d2a-af0d-efb3187a4382', 'Fietstocht', '2026-09-25T00:00:00.000Z'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO products (id, org_id, category_id, name, created_at)
  SELECT '0e6c33a6-afad-47b8-9484-774017b71894', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '36e56b87-3158-4d2a-af0d-efb3187a4382', 'Wandeltocht', '2026-09-25T00:00:00.000Z'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO product_variants (id, org_id, product_id, name, code, position, created_at)
  SELECT '22384d06-0f7d-4708-acbe-7a6ecb88c5ab', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', 'b3bd403b-81b6-4fc7-8f71-4fa663ae3f90', '', 'bon', 0, '2026-09-25T00:00:00.000Z'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO product_variants (id, org_id, product_id, name, code, position, created_at)
  SELECT '336905ba-674d-43b3-9cf0-c24eb9a6b2bf', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '3b00f42f-4efc-4ae1-8647-86249f0a9d08', 'niet-lid', 'fietstocht', 0, '2026-09-25T00:00:00.000Z'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO product_variants (id, org_id, product_id, name, code, position, created_at)
  SELECT 'b486a05f-4763-43e8-a4d5-aac710228ea2', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '3b00f42f-4efc-4ae1-8647-86249f0a9d08', 'lid', 'fietstochtMember', 1, '2026-09-25T00:00:00.000Z'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO product_variants (id, org_id, product_id, name, code, position, created_at)
  SELECT 'f6a9cf01-8bf2-408f-84df-4f3249634009', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '0e6c33a6-afad-47b8-9484-774017b71894', 'niet-lid', 'wandeltocht', 0, '2026-09-25T00:00:00.000Z'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO product_variants (id, org_id, product_id, name, code, position, created_at)
  SELECT 'e18b7a50-8ba0-49c0-a7b7-d642cbd3e05a', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '0e6c33a6-afad-47b8-9484-774017b71894', 'lid', 'wandeltochtMember', 1, '2026-09-25T00:00:00.000Z'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO catalogs (id, org_id, name, is_default, created_at, updated_at)
  SELECT '0096183e-958d-450d-89a8-bc8a87845e67', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', 'Standaard', 1, '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO catalog_sections (id, org_id, catalog_id, name, position)
  SELECT '1b476120-123a-426f-aefd-9c58e836d992', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '0096183e-958d-450d-89a8-bc8a87845e67', 'Bonnen', 0
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO catalog_sections (id, org_id, catalog_id, name, position)
  SELECT '75768b34-10fb-4e16-8615-ad5369995dcf', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '0096183e-958d-450d-89a8-bc8a87845e67', 'Tochten', 1
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO catalog_entries (id, org_id, catalog_id, section_id, variant_id, price_cents, visible, position, quick_quantities)
  SELECT '31d5f5e8-60bc-48e3-aa79-959a5d66cad5', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '0096183e-958d-450d-89a8-bc8a87845e67', '1b476120-123a-426f-aefd-9c58e836d992', '22384d06-0f7d-4708-acbe-7a6ecb88c5ab', 100, 1, 0, '[5,10,15,20,25,30,35,40]'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO catalog_entries (id, org_id, catalog_id, section_id, variant_id, price_cents, visible, position, quick_quantities)
  SELECT 'eb5a8fdd-ffe6-44dc-80fd-b1c38dacccc9', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '0096183e-958d-450d-89a8-bc8a87845e67', '75768b34-10fb-4e16-8615-ad5369995dcf', '336905ba-674d-43b3-9cf0-c24eb9a6b2bf', 800, 1, 0, NULL
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO catalog_entries (id, org_id, catalog_id, section_id, variant_id, price_cents, visible, position, quick_quantities)
  SELECT '14ebd304-e423-4c11-bef1-a4b65ea2d135', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '0096183e-958d-450d-89a8-bc8a87845e67', '75768b34-10fb-4e16-8615-ad5369995dcf', 'b486a05f-4763-43e8-a4d5-aac710228ea2', 500, 1, 1, NULL
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO catalog_entries (id, org_id, catalog_id, section_id, variant_id, price_cents, visible, position, quick_quantities)
  SELECT 'bc658ae3-3fcb-43ea-bec7-dff2f4af4245', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '0096183e-958d-450d-89a8-bc8a87845e67', '75768b34-10fb-4e16-8615-ad5369995dcf', 'f6a9cf01-8bf2-408f-84df-4f3249634009', 600, 1, 2, NULL
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');

INSERT OR IGNORE INTO catalog_entries (id, org_id, catalog_id, section_id, variant_id, price_cents, visible, position, quick_quantities)
  SELECT 'b5f76626-fb2f-43a8-993d-d4425b0b3145', '7f855c6b-1574-41c6-9c19-576b84dd2ee4', '0096183e-958d-450d-89a8-bc8a87845e67', '75768b34-10fb-4e16-8615-ad5369995dcf', 'e18b7a50-8ba0-49c0-a7b7-d642cbd3e05a', 300, 1, 3, NULL
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = '7f855c6b-1574-41c6-9c19-576b84dd2ee4');
