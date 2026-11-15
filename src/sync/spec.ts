// What a local instance syncs to its cloud backup (OFFLINE.md): the tables
// and columns, and the triggers that record every change in sync_outbox.
//
// The list starts from the org export (EXPORT_TABLES) — its coverage test
// guards both — minus memberships (the cloud org has its own members), plus
// what an export leaves out on purpose but a backup with the same ids and the
// same hostname needs (PINs, QR tokens, self-order links), plus the org's
// own settings (its organizations row, branding, icons).
//
// Ids stay the same on both sides: no remapping.
import { EXPORT_TABLES } from '../org-transfer';

export interface SyncTable {
  table: string;
  // The column that names the org: org_id, or id for organizations itself.
  orgColumn: string;
  // The primary key without the org (org_counters: name; charge_lines: charge_id + line_id).
  key: string[];
  // Synced columns, the key included, the org column not.
  columns: string[];
  // Every other column, with why it stays behind (a test checks the cover).
  excluded: Record<string, string>;
  secret?: 'payment';
}

// Columns an export leaves out but a backup keeps: with the same ids and the
// same hostname they keep working after a promotion.
const SYNC_EXTRA: Record<string, string[]> = {
  staff: ['pin_hash', 'pin_changed_at'],
  tables: ['qr_token'],
  events: ['self_order_enabled', 'self_order_code', 'self_order_slug'],
  tabs: ['order_token'],
  // Synced encrypted; the cloud re-encrypts with its own org key (phase 2).
  payment_provider_credentials: ['config_ciphertext', 'config_iv'],
};

// Columns an export keeps but a backup doesn't.
const SYNC_DROP: Record<string, Record<string, string>> = {
  staff: { member_id: "a membership of this installation; the cloud org has its own members" },
};

const KEYS: Record<string, string[]> = {
  org_counters: ['name'],
  charge_lines: ['charge_id', 'line_id'],
  payment_provider_credentials: ['provider'],
};

const fromExport: SyncTable[] = EXPORT_TABLES.filter((s) => s.table !== 'memberships').map((s) => {
  const extra = SYNC_EXTRA[s.table] ?? [];
  const drop = SYNC_DROP[s.table] ?? {};
  const excluded: Record<string, string> = { ...drop };
  for (const [column, why] of Object.entries(s.excluded)) if (column !== 'org_id' && !extra.includes(column)) excluded[column] = why;
  return {
    table: s.table,
    orgColumn: 'org_id',
    key: KEYS[s.table] ?? ['id'],
    columns: [...s.columns.filter((c) => !(c in drop)), ...extra],
    excluded,
    ...(s.secret ? { secret: s.secret } : {}),
  };
});

// The org's own settings. First in the list: the backfill sends them first.
const ORG_SETTINGS: SyncTable[] = [
  {
    table: 'organizations',
    orgColumn: 'id',
    key: [],
    columns: ['name', 'logo_url', 'theme', 'locale', 'staff_required', 'receipts_enabled', 'blind_count'],
    excluded: {
      dek_ciphertext: "each instance has its own org key",
      dek_iv: "each instance has its own org key",
      created_at: 'when the org was made on this instance',
      created_by_sub: "a person of this installation's identity provider",
      custom_domain: 'unused (an instance setting now)',
      custom_domain_cf_id: 'unused (an instance setting now)',
      custom_domain_route_id: 'unused (an instance setting now)',
      custom_domain_status: 'unused (an instance setting now)',
      custom_domain_ssl_status: 'unused (an instance setting now)',
      import_status: 'only while importing an export file',
      import_key: 'only while importing an export file',
      import_manifest: 'only while importing an export file',
      is_locked: "this installation's demo cleanup",
    },
  },
  { table: 'org_branding', orgColumn: 'org_id', key: [], columns: ['primary_color', 'accent_color', 'logo_png', 'logo_updated_at', 'updated_at'], excluded: {} },
  { table: 'org_icons', orgColumn: 'org_id', key: ['slot', 'size'], columns: ['slot', 'size', 'png', 'updated_at'], excluded: {} },
];

// In foreign-key order: the cloud applies them in exactly this order.
export const SYNC_TABLES: SyncTable[] = [...ORG_SETTINGS, ...fromExport];

export const SYNC_TABLE = new Map(SYNC_TABLES.map((t) => [t.table, t]));

// The row's key as stored in sync_outbox.row_key: a JSON array of the key's
// values ([] for a table with one row per org).
function keySql(t: SyncTable, row: 'NEW' | 'OLD'): string {
  return `json_array(${t.key.map((c) => `${row}.${c}`).join(', ')})`;
}

export interface SyncTrigger {
  name: string;
  sql: string;
}

// Three triggers per table, recording a change only for an org that is the
// source of a sync link: a cloud-only installation writes nothing extra.
// An update only counts when it sets a synced column (a table's room state,
// a payment's provider data and the like change often and stay behind).
export function syncTriggers(t: SyncTable): SyncTrigger[] {
  const make = (op: 'insert' | 'update' | 'delete') => {
    const row = op === 'delete' ? 'OLD' : 'NEW';
    const event = op === 'update' ? `UPDATE OF ${[...t.key, ...t.columns.filter((c) => !t.key.includes(c))].join(', ')}` : op.toUpperCase();
    return {
      name: `sync_${t.table}_${op}`,
      sql:
        `CREATE TRIGGER IF NOT EXISTS sync_${t.table}_${op} AFTER ${event} ON ${t.table}\n` +
        `WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = ${row}.${t.orgColumn} AND role = 'source')\n` +
        `BEGIN\n` +
        `  INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)\n` +
        `  VALUES (${row}.${t.orgColumn}, '${t.table}', ${keySql(t, row)}, '${op}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));\n` +
        `END`,
    };
  };
  return [make('insert'), make('update'), make('delete')];
}

// On the cloud a replica org is read-only for people (OFFLINE.md): a write to
// a synced table of a replica org aborts, unless it is the sync itself (which
// marks its own transaction in sync_applying, see replica.ts). In the
// database, so no route (kassa, console, guests, payment callbacks) can
// slip past it. Updates only count when they set a synced column, as above.
export const READ_ONLY_ERROR = 'org_read_only';

export function guardTriggers(t: SyncTable): SyncTrigger[] {
  const make = (op: 'insert' | 'update' | 'delete') => {
    const row = op === 'delete' ? 'OLD' : 'NEW';
    const event = op === 'update' ? `UPDATE OF ${[...t.key, ...t.columns.filter((c) => !t.key.includes(c))].join(', ')}` : op.toUpperCase();
    return {
      name: `sync_guard_${t.table}_${op}`,
      sql:
        `CREATE TRIGGER IF NOT EXISTS sync_guard_${t.table}_${op} BEFORE ${event} ON ${t.table}\n` +
        `WHEN EXISTS (SELECT 1 FROM sync_links WHERE org_id = ${row}.${t.orgColumn} AND role = 'replica')\n` +
        `  AND NOT EXISTS (SELECT 1 FROM sync_applying WHERE org_id = ${row}.${t.orgColumn})\n` +
        `BEGIN\n` +
        `  SELECT RAISE(ABORT, '${READ_ONLY_ERROR}');\n` +
        `END`,
    };
  };
  return [make('insert'), make('update'), make('delete')];
}

export function allSyncTriggers(): SyncTrigger[] {
  return SYNC_TABLES.flatMap((t) => [...syncTriggers(t), ...guardTriggers(t)]);
}

// Synced columns that name a row of another synced table (its id): the cloud
// checks they belong to the same org before applying a batch. A test checks
// this against the schema's foreign keys.
export const SYNC_REFS: Record<string, Record<string, string>> = {
  products: { category_id: 'categories', prep_station_id: 'prep_stations' },
  product_variants: { product_id: 'products' },
  catalog_sections: { catalog_id: 'catalogs' },
  catalog_entries: { catalog_id: 'catalogs', section_id: 'catalog_sections', variant_id: 'product_variants' },
  events: { catalog_id: 'catalogs' },
  event_order_modes: { event_id: 'events', catalog_id: 'catalogs' },
  shifts: { register_id: 'registers' },
  cash_movements: { shift_id: 'shifts' },
  tabs: { event_id: 'events' },
  orders: { tab_id: 'tabs', catalog_id: 'catalogs' },
  order_lines: { tab_id: 'tabs', order_id: 'orders', voids_line_id: 'order_lines' },
  prep_tickets: { tab_id: 'tabs', order_id: 'orders' },
  charges: { tab_id: 'tabs' },
  charge_lines: { charge_id: 'charges', tab_id: 'tabs', line_id: 'order_lines' },
  transactions: { tab_id: 'tabs', event_id: 'events' },
};

// Both sides must sync the same tables and columns. The protocol number
// changes with the batch format; the schema fingerprint with the spec, so a
// box and a cloud on releases with different synced columns stop and say so
// instead of losing a column.
export const SYNC_PROTOCOL = 1;

export const SYNC_SCHEMA = (() => {
  const text = JSON.stringify(SYNC_TABLES.map((t) => [t.table, t.key, t.columns]));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
})();
