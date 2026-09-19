-- One-time migration for the existing production `questo-transactions` D1
-- database: lets an org register a separate OAuth client, used only for the
-- authorization-code flow (browser /login and /:orgId/console), distinct
-- from the client_id/client_secret used for the device grant (/:orgId/device).
-- Needed because some providers (Google) require a different OAuth client
-- per flow — a device-grant "TV and Limited Input" client can't do the
-- authorization-code flow, and a "Web application" client can't do the
-- device grant — whereas Auth0's one Application can do both, so existing
-- orgs work unchanged with these columns left NULL.
--   wrangler d1 execute questo-transactions --remote --file=migrations/0008_auth_code_client.sql
ALTER TABLE identity_providers ADD COLUMN auth_code_client_id TEXT;
ALTER TABLE identity_providers ADD COLUMN auth_code_client_secret_ciphertext TEXT;
ALTER TABLE identity_providers ADD COLUMN auth_code_client_secret_iv TEXT;
