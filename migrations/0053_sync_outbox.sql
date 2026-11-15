-- Offline (OFFLINE.md): a local instance syncs its orgs one way to a cloud
-- backup. sync_links names an org's role in that: 'source' on the box (it
-- sends), 'replica' on the cloud (it receives). sync_outbox records every
-- change of a source org, in the same transaction (the triggers below, from
-- src/sync/spec.ts), until the cloud has it. Cloud-only installations have
-- no source links, so the triggers write nothing there.
CREATE TABLE IF NOT EXISTS sync_links (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('source', 'replica')),
  -- Source: the cloud's address and the sync key (encrypted under the org's data key).
  remote_url TEXT,
  key_ciphertext TEXT,
  key_iv TEXT,
  -- Replica: the sync key's SHA-256.
  key_hash TEXT,
  created_at TEXT NOT NULL,
  -- Status: the last batch that got through, the last sequence the other
  -- side has, the last error, the first sync's end.
  last_sync_at TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  backfill_done_at TEXT
);
-- AUTOINCREMENT: a sequence number is never reused, even once the outbox is
-- emptied (the cloud remembers the last one it applied).
CREATE TABLE IF NOT EXISTS sync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete', 'backfill')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_org ON sync_outbox(org_id, seq);
-- Every synced table: AFTER INSERT, UPDATE OF its synced columns, DELETE.
-- test/sync-capture.test.ts checks they match src/sync/spec.ts.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
CREATE TRIGGER IF NOT EXISTS sync_organizations_insert AFTER INSERT ON organizations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.id, 'organizations', json_array(), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_organizations_update AFTER UPDATE OF name, logo_url, theme, locale, staff_required, receipts_enabled, blind_count ON organizations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.id, 'organizations', json_array(), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_organizations_delete AFTER DELETE ON organizations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.id, 'organizations', json_array(), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_org_branding_insert AFTER INSERT ON org_branding
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'org_branding', json_array(), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_org_branding_update AFTER UPDATE OF primary_color, accent_color, logo_png, logo_updated_at, updated_at ON org_branding
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'org_branding', json_array(), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_org_branding_delete AFTER DELETE ON org_branding
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'org_branding', json_array(), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_org_icons_insert AFTER INSERT ON org_icons
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'org_icons', json_array(NEW.slot, NEW.size), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_org_icons_update AFTER UPDATE OF slot, size, png, updated_at ON org_icons
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'org_icons', json_array(NEW.slot, NEW.size), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_org_icons_delete AFTER DELETE ON org_icons
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'org_icons', json_array(OLD.slot, OLD.size), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_staff_insert AFTER INSERT ON staff
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'staff', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_staff_update AFTER UPDATE OF id, name, created_at, archived_at, pin_hash, pin_changed_at ON staff
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'staff', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_staff_delete AFTER DELETE ON staff
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'staff', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_categories_insert AFTER INSERT ON categories
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'categories', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_categories_update AFTER UPDATE OF id, name, position, created_at ON categories
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'categories', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_categories_delete AFTER DELETE ON categories
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'categories', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_prep_stations_insert AFTER INSERT ON prep_stations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'prep_stations', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_prep_stations_update AFTER UPDATE OF id, name, position, created_at ON prep_stations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'prep_stations', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_prep_stations_delete AFTER DELETE ON prep_stations
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'prep_stations', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_products_insert AFTER INSERT ON products
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'products', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_products_update AFTER UPDATE OF id, category_id, prep_station_id, name, vat_rate_bp, archived_at, created_at ON products
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'products', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_products_delete AFTER DELETE ON products
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'products', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_product_variants_insert AFTER INSERT ON product_variants
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'product_variants', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_product_variants_update AFTER UPDATE OF id, product_id, name, code, position, archived_at, created_at ON product_variants
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'product_variants', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_product_variants_delete AFTER DELETE ON product_variants
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'product_variants', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_catalogs_insert AFTER INSERT ON catalogs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'catalogs', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_catalogs_update AFTER UPDATE OF id, name, is_default, archived_at, created_at, updated_at ON catalogs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'catalogs', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_catalogs_delete AFTER DELETE ON catalogs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'catalogs', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_catalog_sections_insert AFTER INSERT ON catalog_sections
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'catalog_sections', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_catalog_sections_update AFTER UPDATE OF id, catalog_id, name, position, color ON catalog_sections
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'catalog_sections', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_catalog_sections_delete AFTER DELETE ON catalog_sections
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'catalog_sections', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_catalog_entries_insert AFTER INSERT ON catalog_entries
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'catalog_entries', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_catalog_entries_update AFTER UPDATE OF id, catalog_id, section_id, variant_id, price_cents, visible, position, quick_quantities ON catalog_entries
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'catalog_entries', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_catalog_entries_delete AFTER DELETE ON catalog_entries
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'catalog_entries', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_events_insert AFTER INSERT ON events
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'events', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_events_update AFTER UPDATE OF id, name, event_date, created_at, catalog_id, order_counter, self_order_pay_counter, self_order_pay_bancontact, self_order_tabs, kassa_modes, brand_primary, brand_accent, end_date, self_order_enabled, self_order_code, self_order_slug ON events
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'events', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_events_delete AFTER DELETE ON events
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'events', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_event_order_modes_insert AFTER INSERT ON event_order_modes
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'event_order_modes', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_event_order_modes_update AFTER UPDATE OF id, event_id, name, position, catalog_id, self_order, kassa, pay_counter, pay_bancontact, tabs, created_at, notify_sms, tab_contact, at_table ON event_order_modes
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'event_order_modes', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_event_order_modes_delete AFTER DELETE ON event_order_modes
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'event_order_modes', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_org_counters_insert AFTER INSERT ON org_counters
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'org_counters', json_array(NEW.name), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_org_counters_update AFTER UPDATE OF name, value ON org_counters
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'org_counters', json_array(NEW.name), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_org_counters_delete AFTER DELETE ON org_counters
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'org_counters', json_array(OLD.name), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_tables_insert AFTER INSERT ON tables
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'tables', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_tables_update AFTER UPDATE OF id, name, zone, position, cleared_at, created_at, archived_at, qr_token ON tables
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'tables', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_tables_delete AFTER DELETE ON tables
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'tables', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_registers_insert AFTER INSERT ON registers
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'registers', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_registers_update AFTER UPDATE OF id, name, created_at, archived_at ON registers
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'registers', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_registers_delete AFTER DELETE ON registers
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'registers', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_shifts_insert AFTER INSERT ON shifts
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'shifts', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_shifts_update AFTER UPDATE OF id, register_id, number, status, opened_at, opened_by_name, opened_by_staff_name, opening_float_cents, opening_count, closed_at, closed_by_name, closed_by_staff_name, counted_cents, closing_count, expected_cents, difference_cents, totals, note, left_in_drawer_cents ON shifts
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'shifts', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_shifts_delete AFTER DELETE ON shifts
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'shifts', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_cash_movements_insert AFTER INSERT ON cash_movements
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'cash_movements', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_cash_movements_update AFTER UPDATE OF id, shift_id, direction, amount_cents, reason, device_name, user_name, staff_name, created_at ON cash_movements
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'cash_movements', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_cash_movements_delete AFTER DELETE ON cash_movements
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'cash_movements', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_tabs_insert AFTER INSERT ON tabs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'tabs', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_tabs_update AFTER UPDATE OF id, number, label, status, slot_id, event_id, opened_device_id, opened_device_name, opened_by_name, opened_by_email, opened_at, closed_at, receipt_number, cancel_reason, split_parts, split_paid, event_number, source, pay_later, order_mode_id, order_mode_name, staff_id, staff_name, table_id, order_token ON tabs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'tabs', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_tabs_delete AFTER DELETE ON tabs
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'tabs', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_orders_insert AFTER INSERT ON orders
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'orders', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_orders_update AFTER UPDATE OF id, tab_id, source, catalog_id, device_id, device_name, user_name, user_email, submitted_at, staff_id, staff_name ON orders
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'orders', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_orders_delete AFTER DELETE ON orders
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'orders', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_order_lines_insert AFTER INSERT ON order_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'order_lines', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_order_lines_update AFTER UPDATE OF id, tab_id, order_id, item_code, variant_id, name, unit_price_cents, quantity, category, vat_rate_bp, prep_station_id, prep_station_name, note, voids_line_id, void_reason, created_at ON order_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'order_lines', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_order_lines_delete AFTER DELETE ON order_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'order_lines', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_prep_tickets_insert AFTER INSERT ON prep_tickets
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'prep_tickets', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_prep_tickets_update AFTER UPDATE OF id, tab_id, order_id, station_id, station_name, status, created_at, updated_at, updated_by, sms_status, push_status, claimed_by_staff_id, claimed_by_name, claimed_at ON prep_tickets
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'prep_tickets', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_prep_tickets_delete AFTER DELETE ON prep_tickets
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'prep_tickets', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_charges_insert AFTER INSERT ON charges
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'charges', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_charges_update AFTER UPDATE OF id, method, status, provider_status, amount_cents, description, items, slot_id, device_id, device_name, user_name, user_email, created_at, resolved_at, transaction_code, error_message, provider_ref, expires_at, tab_id, tip_cents, split_part, split_count, staff_id, staff_name, shift_id ON charges
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'charges', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_charges_delete AFTER DELETE ON charges
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'charges', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_charge_lines_insert AFTER INSERT ON charge_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'charge_lines', json_array(NEW.charge_id, NEW.line_id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_charge_lines_update AFTER UPDATE OF charge_id, line_id, tab_id, quantity ON charge_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'charge_lines', json_array(NEW.charge_id, NEW.line_id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_charge_lines_delete AFTER DELETE ON charge_lines
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'charge_lines', json_array(OLD.charge_id, OLD.line_id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_transactions_insert AFTER INSERT ON transactions
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'transactions', json_array(NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_transactions_update AFTER UPDATE OF id, amount_cents, description, method, items, slot_id, device_id, device_name, user_name, user_email, event_id, tab_id, tip_cents, completed_at, staff_id, staff_name, shift_id ON transactions
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'transactions', json_array(NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_transactions_delete AFTER DELETE ON transactions
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'transactions', json_array(OLD.id), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_payment_provider_credentials_insert AFTER INSERT ON payment_provider_credentials
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'payment_provider_credentials', json_array(NEW.provider), 'insert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_payment_provider_credentials_update AFTER UPDATE OF provider, updated_at, config_ciphertext, config_iv ON payment_provider_credentials
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = NEW.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (NEW.org_id, 'payment_provider_credentials', json_array(NEW.provider), 'update', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS sync_payment_provider_credentials_delete AFTER DELETE ON payment_provider_credentials
WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = OLD.org_id AND role = 'source')
BEGIN
  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
  VALUES (OLD.org_id, 'payment_provider_credentials', json_array(OLD.provider), 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
