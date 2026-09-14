-- One-time migration for the existing production `questo-transactions` D1
-- database: adds the columns needed for per-organization identity providers.
-- Run once via:
--   wrangler d1 execute questo-transactions --remote --file=migrations/0002_multi_issuer_identity.sql
-- Safe to run once; ALTER TABLE ADD COLUMN errors if re-run (columns already
-- exist).

-- Resolved once from issuer_url's /.well-known/openid-configuration at
-- admin-save time — see worker/src/organizations/idp-resolution.ts. Never
-- re-fetched at login time.
ALTER TABLE identity_providers ADD COLUMN authorization_endpoint TEXT;
ALTER TABLE identity_providers ADD COLUMN token_endpoint TEXT;
ALTER TABLE identity_providers ADD COLUMN userinfo_endpoint TEXT;
ALTER TABLE identity_providers ADD COLUMN device_authorization_endpoint TEXT;
ALTER TABLE identity_providers ADD COLUMN end_session_endpoint TEXT;

-- A bare `user_sub` is only unique within the issuer that minted it. Every
-- existing membership was authenticated against the platform's one shared
-- Auth0 tenant, so backfill them all with that tenant's real issuer URL
-- (Auth0's `iss` claim format: https://<domain>/, trailing slash included) —
-- replace the literal below with the real AUTH0_DOMAIN value before running.
ALTER TABLE memberships ADD COLUMN issuer TEXT;
UPDATE memberships SET issuer = 'https://auth.esvvzw.be/' WHERE issuer IS NULL;

CREATE INDEX IF NOT EXISTS idx_memberships_issuer_sub ON memberships(issuer, user_sub);
