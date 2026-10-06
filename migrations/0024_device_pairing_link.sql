-- A pairing code for a customer display can name the kassa it's for
-- (devices.ts): the display is linked to it as soon as it's paired.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE device_pairings ADD COLUMN link_to TEXT;
