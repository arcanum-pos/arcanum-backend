// Offline sync, the box's side (OFFLINE.md, phase 1): what is synced
// (src/sync/spec.ts) and the triggers that record every change of a source
// org in sync_outbox.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SYNC_TABLES, syncTriggers } from '../src/sync/spec';
import { createTab, payCash, rows, seedOrg, type TestOrg } from './helpers';

const now = () => new Date().toISOString();

async function link(org: TestOrg, role: 'source' | 'replica' = 'source') {
  await env.DB.prepare('INSERT INTO sync_links (org_id, role, created_at) VALUES (?, ?, ?)').bind(org.orgId, role, now()).run();
}

async function outbox(org: TestOrg) {
  return rows<{ seq: number; table_name: string; row_key: string; op: string }>(
    'SELECT seq, table_name, row_key, op FROM sync_outbox WHERE org_id = ? ORDER BY seq',
    org.orgId
  );
}

const normalize = (sql: string) => sql.replace(/IF NOT EXISTS /i, '').replace(/\s+/g, ' ').trim();

describe('the sync spec', () => {
  it('covers every column of every synced table: synced, the org, or left out with a reason', async () => {
    for (const t of SYNC_TABLES) {
      const columns = (await rows<{ name: string }>(`SELECT name FROM pragma_table_info('${t.table}')`)).map((r) => r.name);
      expect(columns.length, t.table).toBeGreaterThan(0);
      const handled = [t.orgColumn, ...t.columns, ...Object.keys(t.excluded)];
      expect(columns.filter((c) => !handled.includes(c)), t.table).toEqual([]);
      expect(handled.filter((c) => !columns.includes(c)), t.table).toEqual([]);
      expect(t.columns.filter((c) => c in t.excluded), t.table).toEqual([]);
    }
  });

  it("names each table's primary key (without the org) as its key", async () => {
    for (const t of SYNC_TABLES) {
      const pk = (await rows<{ name: string; pk: number }>(`SELECT name, pk FROM pragma_table_info('${t.table}') WHERE pk > 0 ORDER BY pk`)).map((r) => r.name);
      expect(pk.filter((c) => c !== t.orgColumn), t.table).toEqual(t.key);
      for (const c of t.key) expect(t.columns, t.table).toContain(c);
    }
  });

  it('keeps PINs, QR tokens and self-order links, and never an org key or a membership', () => {
    const cols = (table: string) => SYNC_TABLES.find((t) => t.table === table)!.columns;
    expect(cols('staff')).toEqual(expect.arrayContaining(['pin_hash', 'pin_changed_at']));
    expect(cols('staff')).not.toContain('member_id');
    expect(cols('tables')).toContain('qr_token');
    expect(cols('events')).toEqual(expect.arrayContaining(['self_order_enabled', 'self_order_code', 'self_order_slug']));
    expect(cols('organizations')).not.toContain('dek_ciphertext');
    expect(SYNC_TABLES.map((t) => t.table)).not.toContain('memberships');
    expect(SYNC_TABLES.map((t) => t.table)).not.toContain('devices');
  });
});

describe('the sync triggers', () => {
  it('exist for every synced table, exactly as src/sync/spec.ts makes them', async () => {
    // A later migration that rebuilds a table drops its triggers, and a new
    // synced column needs them made again: both fail here.
    const have = new Map(
      (await rows<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' ESCAPE '\\'`)).map((r) => [r.name, r.sql])
    );
    const want = SYNC_TABLES.flatMap(syncTriggers);
    for (const trigger of want) expect(normalize(have.get(trigger.name) ?? 'missing'), trigger.name).toBe(normalize(trigger.sql));
    expect([...have.keys()].sort()).toEqual(want.map((t) => t.name).sort());
  });
});

describe('capturing changes', () => {
  it('records nothing for an org without a source link (cloud-only, or a replica)', async () => {
    const plain = await seedOrg();
    const tab = await createTab(plain, { label: 'Tafel 1', lines: [{ itemCode: 'cola', name: 'Cola', unitPriceCents: 300, quantity: 1 }] });
    await payCash(plain, tab.id, 300);
    expect(await outbox(plain)).toEqual([]);

    const replica = await seedOrg();
    await link(replica, 'replica');
    await createTab(replica, { label: 'Tafel 2', lines: [{ itemCode: 'cola', name: 'Cola', unitPriceCents: 300, quantity: 1 }] });
    expect(await outbox(replica)).toEqual([]);
  });

  it('records a sale of a source org: every row it writes, by key, in order', async () => {
    const org = await seedOrg();
    await link(org);
    const tab = await createTab(org, { label: 'Tafel 1', lines: [{ itemCode: 'cola', name: 'Cola', unitPriceCents: 300, quantity: 2 }] });
    const before = (await outbox(org)).length;
    const chargeId = await payCash(org, tab.id, 600);

    const all = await outbox(org);
    const tables = new Set(all.map((r) => r.table_name));
    for (const t of ['catalogs', 'products', 'product_variants', 'catalog_entries', 'tabs', 'orders', 'order_lines', 'charges', 'transactions']) expect(tables, t).toContain(t);
    expect(all.find((r) => r.table_name === 'tabs' && r.op === 'insert')?.row_key).toBe(JSON.stringify([tab.id]));
    expect(all.slice(before)).toEqual(expect.arrayContaining([expect.objectContaining({ table_name: 'charges', row_key: JSON.stringify([chargeId]), op: 'insert' })]));
    // Paying closes the tab: an update of a synced column.
    expect(all.slice(before)).toEqual(expect.arrayContaining([expect.objectContaining({ table_name: 'tabs', row_key: JSON.stringify([tab.id]), op: 'update' })]));
    const seqs = all.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('records deletes with the old key, and composite and per-org keys', async () => {
    const org = await seedOrg();
    await link(org);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO org_counters (org_id, name, value) VALUES (?, ?, 1)').bind(org.orgId, 'test_counter'),
      env.DB.prepare("INSERT INTO categories (id, org_id, name, position, created_at) VALUES ('cat-x', ?, 'X', 0, ?)").bind(org.orgId, now()),
      env.DB.prepare("DELETE FROM categories WHERE id = 'cat-x' AND org_id = ?").bind(org.orgId),
      env.DB.prepare("UPDATE organizations SET name = 'Nieuwe naam' WHERE id = ?").bind(org.orgId),
    ]);
    expect((await outbox(org)).map(({ table_name, row_key, op }) => [table_name, row_key, op])).toEqual([
      ['org_counters', '["test_counter"]', 'insert'],
      ['categories', '["cat-x"]', 'insert'],
      ['categories', '["cat-x"]', 'delete'],
      ['organizations', '[]', 'update'],
    ]);
  });

  it('ignores updates of columns that stay behind (the room right now, a printer, the demo lock)', async () => {
    const org = await seedOrg();
    await link(org);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tables (id, org_id, name, position, created_at) VALUES ('t-1', ?, 'T1', 0, ?)").bind(org.orgId, now()),
      env.DB.prepare("UPDATE tables SET needs_clearing_at = ?, promised_at = ? WHERE id = 't-1'").bind(now(), now()),
      env.DB.prepare("UPDATE organizations SET is_locked = 'N' WHERE id = ?").bind(org.orgId),
      env.DB.prepare("UPDATE tables SET name = 'Terras 1' WHERE id = 't-1'"),
    ]);
    expect((await outbox(org)).map((r) => `${r.table_name} ${r.op}`)).toEqual(['tables insert', 'tables update']);
  });

  it('never reuses a sequence number once the outbox is emptied', async () => {
    const org = await seedOrg();
    await link(org);
    await env.DB.prepare("UPDATE organizations SET name = 'A' WHERE id = ?").bind(org.orgId).run();
    const [first] = await outbox(org);
    await env.DB.prepare('DELETE FROM sync_outbox WHERE org_id = ?').bind(org.orgId).run();
    await env.DB.prepare("UPDATE organizations SET name = 'B' WHERE id = ?").bind(org.orgId).run();
    const [second] = await outbox(org);
    expect(second.seq).toBeGreaterThan(first.seq);
  });
});
