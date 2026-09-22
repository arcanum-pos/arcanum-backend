-- One-time migration for the existing production `arcanum-backend` D1
-- database: lets an org override the OAuth scope string requested at
-- login/device-flow time. Needed because not every OIDC provider agrees on
-- scope names — Auth0 uses `offline_access` to get a refresh token; Google
-- rejects that scope outright (invalid_scope) and instead relies on the
-- device grant issuing a refresh token by default. Nullable — NULL keeps
-- today's hardcoded 'openid profile email offline_access' default, so
-- every existing org keeps working unchanged.
--   wrangler d1 execute arcanum-backend --remote --file=migrations/0007_idp_scopes.sql
ALTER TABLE identity_providers ADD COLUMN scopes TEXT;
