-- One-time migration for the existing production `questo-transactions` D1
-- database: adds an optional, admin-settable short slug for an
-- organization, so a device/login link doesn't have to expose a raw UUID
-- (e.g. "/scouts-elewijt/device" instead of "/3f2a.../device"). Nullable —
-- SQLite treats multiple NULLs in a unique index as distinct, so orgs
-- without one just keep working via their id.
--   wrangler d1 execute questo-transactions --remote --file=migrations/0005_org_slug.sql
ALTER TABLE organizations ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);
