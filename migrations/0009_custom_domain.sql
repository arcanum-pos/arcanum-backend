-- One-time migration for the existing production `questo-transactions` D1
-- database: lets an org register its own custom domain, via Cloudflare's
-- Custom Hostnames API (Cloudflare for SaaS) against the kaboutersoft.be
-- zone — see organizations/custom-domain.ts. Nullable — an org without one
-- keeps working exactly as today.
--   wrangler d1 execute questo-transactions --remote --file=migrations/0009_custom_domain.sql
ALTER TABLE organizations ADD COLUMN custom_domain TEXT;
ALTER TABLE organizations ADD COLUMN custom_domain_cf_id TEXT;
ALTER TABLE organizations ADD COLUMN custom_domain_status TEXT;
ALTER TABLE organizations ADD COLUMN custom_domain_ssl_status TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_custom_domain ON organizations(custom_domain);
