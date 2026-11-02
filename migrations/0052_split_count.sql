-- "Gelijk verdelen", several parts in one payment (3 of 11 at once): how
-- many parts a payment covers, from charges.split_part on (1 = just that
-- part). Counts toward tabs.split_paid once it succeeds.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE charges ADD COLUMN split_count INTEGER NOT NULL DEFAULT 1;
