-- An organisation's default language (nl | fr | en): what its screens show
-- until a user picks their own, and the language of the mails it sends
-- (e.g. the invite, see email-templates/invite.ts). Existing orgs stay Dutch.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE organizations ADD COLUMN locale TEXT NOT NULL DEFAULT 'nl' CHECK (locale IN ('nl', 'fr', 'en'));
