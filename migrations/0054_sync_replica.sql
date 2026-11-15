-- Offline (OFFLINE.md), the cloud's side. A backup starts as an invite: an
-- instance admin makes a link code (the key's SHA-256 is kept here); the
-- box's first call with it creates the replica org with the box's own org
-- id, its maker as admin, and the key becomes the link's sync key.
CREATE TABLE IF NOT EXISTS sync_invites (
  key_hash TEXT PRIMARY KEY,
  created_by_sub TEXT NOT NULL,
  created_by_issuer TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  org_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_links_key_hash ON sync_links(key_hash);
-- A replica org is read-only (the guard triggers below) except for the sync
-- itself, which puts its org here as the first statement of its batch and
-- takes it out as the last: only inside that transaction is it present.
CREATE TABLE IF NOT EXISTS sync_applying (
  org_id TEXT PRIMARY KEY
);
-- Every synced table: BEFORE INSERT, UPDATE OF its synced columns, DELETE.
-- test/sync-capture.test.ts checks they match src/sync/spec.ts.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
CREATE TRIGGER IF NOT EXISTS sync_guard_organizations_insert BEFORE INSERT ON organizations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_organizations_update BEFORE UPDATE OF name, logo_url, theme, locale, staff_required, receipts_enabled, blind_count ON organizations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_organizations_delete BEFORE DELETE ON organizations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_org_branding_insert BEFORE INSERT ON org_branding
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_org_branding_update BEFORE UPDATE OF primary_color, accent_color, logo_png, logo_updated_at, updated_at ON org_branding
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_org_branding_delete BEFORE DELETE ON org_branding
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_org_icons_insert BEFORE INSERT ON org_icons
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_org_icons_update BEFORE UPDATE OF slot, size, png, updated_at ON org_icons
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_org_icons_delete BEFORE DELETE ON org_icons
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_staff_insert BEFORE INSERT ON staff
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_staff_update BEFORE UPDATE OF id, name, created_at, archived_at, pin_hash, pin_changed_at ON staff
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_staff_delete BEFORE DELETE ON staff
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_categories_insert BEFORE INSERT ON categories
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_categories_update BEFORE UPDATE OF id, name, position, created_at ON categories
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_categories_delete BEFORE DELETE ON categories
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_prep_stations_insert BEFORE INSERT ON prep_stations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_prep_stations_update BEFORE UPDATE OF id, name, position, created_at ON prep_stations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_prep_stations_delete BEFORE DELETE ON prep_stations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_products_insert BEFORE INSERT ON products
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_products_update BEFORE UPDATE OF id, category_id, prep_station_id, name, vat_rate_bp, archived_at, created_at ON products
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_products_delete BEFORE DELETE ON products
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_product_variants_insert BEFORE INSERT ON product_variants
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_product_variants_update BEFORE UPDATE OF id, product_id, name, code, position, archived_at, created_at ON product_variants
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_product_variants_delete BEFORE DELETE ON product_variants
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_catalogs_insert BEFORE INSERT ON catalogs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_catalogs_update BEFORE UPDATE OF id, name, is_default, archived_at, created_at, updated_at ON catalogs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_catalogs_delete BEFORE DELETE ON catalogs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_catalog_sections_insert BEFORE INSERT ON catalog_sections
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_catalog_sections_update BEFORE UPDATE OF id, catalog_id, name, position, color ON catalog_sections
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_catalog_sections_delete BEFORE DELETE ON catalog_sections
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_catalog_entries_insert BEFORE INSERT ON catalog_entries
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_catalog_entries_update BEFORE UPDATE OF id, catalog_id, section_id, variant_id, price_cents, visible, position, quick_quantities ON catalog_entries
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_catalog_entries_delete BEFORE DELETE ON catalog_entries
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_events_insert BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_events_update BEFORE UPDATE OF id, name, event_date, created_at, catalog_id, order_counter, self_order_pay_counter, self_order_pay_bancontact, self_order_tabs, kassa_modes, brand_primary, brand_accent, end_date, self_order_enabled, self_order_code, self_order_slug ON events
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_events_delete BEFORE DELETE ON events
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_event_order_modes_insert BEFORE INSERT ON event_order_modes
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_event_order_modes_update BEFORE UPDATE OF id, event_id, name, position, catalog_id, self_order, kassa, pay_counter, pay_bancontact, tabs, created_at, notify_sms, tab_contact, at_table ON event_order_modes
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_event_order_modes_delete BEFORE DELETE ON event_order_modes
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_org_counters_insert BEFORE INSERT ON org_counters
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_org_counters_update BEFORE UPDATE OF name, value ON org_counters
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_org_counters_delete BEFORE DELETE ON org_counters
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_tables_insert BEFORE INSERT ON tables
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_tables_update BEFORE UPDATE OF id, name, zone, position, cleared_at, created_at, archived_at, qr_token ON tables
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_tables_delete BEFORE DELETE ON tables
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_registers_insert BEFORE INSERT ON registers
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_registers_update BEFORE UPDATE OF id, name, created_at, archived_at ON registers
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_registers_delete BEFORE DELETE ON registers
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_shifts_insert BEFORE INSERT ON shifts
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_shifts_update BEFORE UPDATE OF id, register_id, number, status, opened_at, opened_by_name, opened_by_staff_name, opening_float_cents, opening_count, closed_at, closed_by_name, closed_by_staff_name, counted_cents, closing_count, expected_cents, difference_cents, totals, note, left_in_drawer_cents ON shifts
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_shifts_delete BEFORE DELETE ON shifts
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_cash_movements_insert BEFORE INSERT ON cash_movements
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_cash_movements_update BEFORE UPDATE OF id, shift_id, direction, amount_cents, reason, device_name, user_name, staff_name, created_at ON cash_movements
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_cash_movements_delete BEFORE DELETE ON cash_movements
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_tabs_insert BEFORE INSERT ON tabs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_tabs_update BEFORE UPDATE OF id, number, label, status, slot_id, event_id, opened_device_id, opened_device_name, opened_by_name, opened_by_email, opened_at, closed_at, receipt_number, cancel_reason, split_parts, split_paid, event_number, source, pay_later, order_mode_id, order_mode_name, staff_id, staff_name, table_id, order_token ON tabs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_tabs_delete BEFORE DELETE ON tabs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_orders_insert BEFORE INSERT ON orders
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_orders_update BEFORE UPDATE OF id, tab_id, source, catalog_id, device_id, device_name, user_name, user_email, submitted_at, staff_id, staff_name ON orders
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_orders_delete BEFORE DELETE ON orders
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_order_lines_insert BEFORE INSERT ON order_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_order_lines_update BEFORE UPDATE OF id, tab_id, order_id, item_code, variant_id, name, unit_price_cents, quantity, category, vat_rate_bp, prep_station_id, prep_station_name, note, voids_line_id, void_reason, created_at ON order_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_order_lines_delete BEFORE DELETE ON order_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_prep_tickets_insert BEFORE INSERT ON prep_tickets
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_prep_tickets_update BEFORE UPDATE OF id, tab_id, order_id, station_id, station_name, status, created_at, updated_at, updated_by, sms_status, push_status, claimed_by_staff_id, claimed_by_name, claimed_at ON prep_tickets
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_prep_tickets_delete BEFORE DELETE ON prep_tickets
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_charges_insert BEFORE INSERT ON charges
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_charges_update BEFORE UPDATE OF id, method, status, provider_status, amount_cents, description, items, slot_id, device_id, device_name, user_name, user_email, created_at, resolved_at, transaction_code, error_message, provider_ref, expires_at, tab_id, tip_cents, split_part, split_count, staff_id, staff_name, shift_id ON charges
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_charges_delete BEFORE DELETE ON charges
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_charge_lines_insert BEFORE INSERT ON charge_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_charge_lines_update BEFORE UPDATE OF charge_id, line_id, tab_id, quantity ON charge_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_charge_lines_delete BEFORE DELETE ON charge_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_transactions_insert BEFORE INSERT ON transactions
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_transactions_update BEFORE UPDATE OF id, amount_cents, description, method, items, slot_id, device_id, device_name, user_name, user_email, event_id, tab_id, tip_cents, completed_at, staff_id, staff_name, shift_id ON transactions
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_transactions_delete BEFORE DELETE ON transactions
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_payment_provider_credentials_insert BEFORE INSERT ON payment_provider_credentials
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_payment_provider_credentials_update BEFORE UPDATE OF provider, updated_at, config_ciphertext, config_iv ON payment_provider_credentials
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = NEW.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
CREATE TRIGGER IF NOT EXISTS sync_guard_payment_provider_credentials_delete BEFORE DELETE ON payment_provider_credentials
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'replica')
  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'org_read_only');
END;
