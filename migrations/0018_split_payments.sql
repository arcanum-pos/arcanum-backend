-- Split payments (DOMAIN_MODEL.md "Split payments"): a tab can be paid in
-- parts. "Gelijk verdelen" keeps its plan on the tab — split_parts = what's
-- open when the split started, divided over this many parts; split_paid =
-- how many of them are paid since — so another kassa continues at the next
-- part. charges.split_part: which part a payment is (1-based; 0 = not a part).
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE tabs ADD COLUMN split_parts INTEGER;
ALTER TABLE tabs ADD COLUMN split_paid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE charges ADD COLUMN split_part INTEGER NOT NULL DEFAULT 0;
