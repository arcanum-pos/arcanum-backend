-- One-time migration for the existing production `questo-transactions` D1
-- database: tracks the exact-hostname Workers Route id created alongside
-- each org's Cloudflare custom hostname — see organizations/custom-domain.ts
-- for why every registered domain gets its own route rather than a
-- zone-wide wildcard (kaboutersoft.be hosts ~30 unrelated proxied
-- subdomains a wildcard route would have intercepted).
--   wrangler d1 execute questo-transactions --remote --file=migrations/0010_custom_domain_route.sql
ALTER TABLE organizations ADD COLUMN custom_domain_route_id TEXT;
