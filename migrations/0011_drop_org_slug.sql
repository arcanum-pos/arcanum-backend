-- Drops the organization slug feature. Superseded by: custom-domain orgs
-- are now identified purely by Host header (no path segment at all), and
-- orgs on the shared platform domain use bare, org-agnostic login links too
-- (org context comes from the admin-portal org picker / device-registration
-- prompt instead) — see organizations.ts's resolveOrgId (was
-- resolveOrgIdOrSlug) and custom-domain.ts.
--   wrangler d1 execute questo-transactions --remote --file=migrations/0011_drop_org_slug.sql
DROP INDEX IF EXISTS idx_organizations_slug;
ALTER TABLE organizations DROP COLUMN slug;
