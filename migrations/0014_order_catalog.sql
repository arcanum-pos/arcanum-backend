-- Which catalog an order was sold from (step 3c) — set whenever an order
-- has catalog-priced lines; NULL for orders with only free lines and for
-- everything before this migration. See tabs.ts priceCatalogLines.
-- Run once via:
--   wrangler d1 execute arcanum-backend --remote --file=migrations/0014_order_catalog.sql
ALTER TABLE orders ADD COLUMN catalog_id TEXT REFERENCES catalogs(id);
