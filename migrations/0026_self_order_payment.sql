-- Self-ordering: how guests may pay, per event (DOMAIN_MODEL.md
-- "Self-ordering and station screens"): at the counter (as before) and/or
-- with Bancontact on their phone.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE events ADD COLUMN self_order_pay_counter INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN self_order_pay_bancontact INTEGER NOT NULL DEFAULT 0;
