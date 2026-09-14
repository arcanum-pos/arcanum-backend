-- One-time migration for the existing production `questo-transactions` D1
-- database: adds org-scoping to the existing `transactions` table and
-- creates the new organizations/admin-portal tables. Run once via:
--   wrangler d1 execute questo-transactions --remote --file=migrations/0001_add_org_support.sql
-- Safe to run once; ALTER TABLE ADD COLUMN errors if re-run (column already
-- exists) — everything else here is already idempotent (IF NOT EXISTS).
ALTER TABLE transactions ADD COLUMN org_id TEXT;
