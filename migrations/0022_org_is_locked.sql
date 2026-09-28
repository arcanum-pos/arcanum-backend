-- Automatic clean-up (arcanum-cleaner): an organization with is_locked = 'N'
-- is deleted — every row of it — once it's 4 hours old. Any other value,
-- NULL included, keeps it. Set by hand for now; later for demo orgs.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE organizations ADD COLUMN is_locked TEXT;
