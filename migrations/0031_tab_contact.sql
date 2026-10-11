-- Who's behind a guest's tab (DOMAIN_MODEL.md "Self-ordering and station
-- screens", decision 17): an ordering mode can ask, when a guest opens a tab
-- paid when leaving, for a name (it becomes the tab's name) and a mobile
-- number or e-mail — not verified. Kept only while the tab is open: erased
-- once it's paid or cancelled.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE event_order_modes ADD COLUMN tab_contact INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tabs ADD COLUMN contact_phone TEXT;
ALTER TABLE tabs ADD COLUMN contact_email TEXT;
