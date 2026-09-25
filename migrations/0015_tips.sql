-- Fooi as a tip on the payment instead of an order line (step 3d). The tip
-- is part of the charged amount (the customer pays it in the same payment)
-- but never counts toward a tab's paid amount or revenue. See tabs.ts
-- PAID_SQL and reports.ts.
-- Run once via:
--   wrangler d1 execute arcanum-backend --remote --file=migrations/0015_tips.sql
ALTER TABLE charges ADD COLUMN tip_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN tip_cents INTEGER NOT NULL DEFAULT 0;
