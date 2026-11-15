// Offline sync, the cloud's side (OFFLINE.md, phase 2, src/sync/replica.ts):
// a backup invite, the box's hello that makes the replica org with the box's
// own org id, batches applied as org-guarded upserts and deletes, secrets
// re-encrypted, and a replica that is read-only for people.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { EXPORT_TABLES, remapId } from '../src/org-transfer';
import { decryptWithKey } from '../src/organizations/crypto';
import { getOrgDataKey } from '../src/organizations/organizations';
import { MAX_TABLE_STATEMENTS, parseLinkCode, type SyncBatchTable } from '../src/sync/replica';
import { SYNC_PROTOCOL, SYNC_REFS, SYNC_SCHEMA, SYNC_TABLES } from '../src/sync/spec';
import { api, apiWith, createTab, payCash, rows, seedOrg, type TestOrg, type TestUser } from './helpers';

const VERSION = { protocol: SYNC_PROTOCOL, schema: SYNC_SCHEMA };

async function invite(user: TestUser): Promise<{ url: string; key: string }> {
  const res = await api('POST', '/organizations/backups', { user });
  expect(res.status).toBe(201);
  return parseLinkCode(res.body.code)!;
}

const sync = (key: string, path: string, body: unknown) => apiWith({}, 'POST', `/sync/${path}`, { body, headers: { Authorization: `Bearer ${key}` } });

// A replica on this installation, as a box would make it.
async function replica(owner: TestOrg) {
  const { key } = await invite(owner.admin);
  const orgId = crypto.randomUUID();
  const res = await sync(key, 'hello', { ...VERSION, orgId, name: 'Kassa Elewijt', locale: 'fr' });
  expect(res.status).toBe(201);
  return { key, orgId };
}

// A real org's data (a sale on a menukaart, paid) as the rows a box would
// send, under fresh ids: every id and reference XORed with one random key,
// so the rows are new on this installation and still point at each other.
async function saleRows(): Promise<SyncBatchTable[]> {
  const source = await seedOrg();
  const tab = await createTab(source, { label: 'Tafel 4', lines: [{ itemCode: 'cola', name: 'Cola', unitPriceCents: 300, quantity: 2 }] });
  await payCash(source, tab.id, 600);
  const xor = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const remap = new Map(EXPORT_TABLES.map((s) => [s.table, s.remap]));
  const tables: SyncBatchTable[] = [];
  for (const t of SYNC_TABLES) {
    if (t.secret || t.table === 'organizations') continue;
    const found = await rows<Record<string, unknown>>(`SELECT ${t.columns.join(', ')} FROM ${t.table} WHERE ${t.orgColumn} = ?`, source.orgId);
    if (!found.length) continue;
    for (const row of found) {
      for (const c of remap.get(t.table) ?? []) row[c] = remapId(row[c] as string | null, xor);
      // Unique across the installation, like the ids.
      for (const c of ['order_token', 'qr_token', 'self_order_code', 'self_order_slug']) if (row[c]) row[c] = crypto.randomUUID();
    }
    tables.push({ table: t.table, upserts: found });
  }
  return tables;
}

const count = async (table: string, orgId: string) => (await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`, orgId))[0].n;

describe('a backup invite', () => {
  it('is a link code with this installation and a key, for whoever may create an org here', async () => {
    const org = await seedOrg();
    const res = await api('POST', '/organizations/backups', { user: org.admin });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^arcanum-backup:/);
    expect(parseLinkCode(res.body.code)).toEqual({ url: 'https://arcanum.test', key: expect.any(String) });
    expect(parseLinkCode('arcanum-backup:nonsense')).toBeNull();

    expect((await api('POST', '/organizations/backups', { user: null })).status).toBe(401);
    expect((await apiWith({ ORG_CREATION: 'internal' }, 'POST', '/organizations/backups', { user: org.admin })).body.code).toBe('org_creation_disabled');
  });
});

describe('the box says hello', () => {
  it("makes the replica org with the box's org id, the invite's maker as its admin", async () => {
    const owner = await seedOrg();
    const { orgId, key } = await replica(owner);
    const org = await api('GET', `/organizations/${orgId}`, { user: owner.admin });
    expect(org.status).toBe(200);
    expect(org.body).toMatchObject({ id: orgId, name: 'Kassa Elewijt' });
    expect(await rows('SELECT role FROM sync_links WHERE org_id = ?', orgId)).toEqual([{ role: 'replica' }]);

    // Again: the same replica, and how far it is.
    const again = await sync(key, 'hello', { ...VERSION, orgId, name: 'Kassa Elewijt' });
    expect(again).toEqual({ status: 200, body: { orgId, lastSeq: 0, ...VERSION } });
    // The key belongs to that org only.
    expect((await sync(key, 'hello', { ...VERSION, orgId: crypto.randomUUID(), name: 'X' })).body.code).toBe('sync_wrong_org');
  });

  it('refuses an unknown or used key, a different release, and an org id that exists here', async () => {
    const owner = await seedOrg();
    expect((await sync('not-a-key', 'hello', { ...VERSION, orgId: crypto.randomUUID(), name: 'X' })).status).toBe(401);

    const { key } = await invite(owner.admin);
    const old = await sync(key, 'hello', { protocol: SYNC_PROTOCOL, schema: 'deadbeef', orgId: crypto.randomUUID(), name: 'X' });
    expect(old.status).toBe(409);
    expect(old.body).toMatchObject({ code: 'sync_version_mismatch', schema: SYNC_SCHEMA });

    expect((await sync(key, 'hello', { ...VERSION, orgId: owner.orgId, name: 'X' })).body.code).toBe('sync_org_exists');
    expect((await sync(key, 'hello', { ...VERSION, orgId: crypto.randomUUID(), name: 'X' })).status).toBe(201);
    // Used: a second org can't come in on the same invite.
    expect((await sync(key, 'hello', { ...VERSION, orgId: crypto.randomUUID(), name: 'Y' })).body.code).toBe('sync_wrong_org');
  });
});

describe('batches', () => {
  it("apply a box's sale: every row, under the replica's org, within the query budget", async () => {
    const { orgId, key } = await replica(await seedOrg());
    const tables = await saleRows();
    const res = await sync(key, 'batch', { ...VERSION, toSeq: 42, tables });
    expect(res).toEqual({ status: 200, body: { lastSeq: 42 } });
    for (const t of tables) expect(await count(t.table, orgId), t.table).toBe(t.upserts!.length);
    const tab = tables.find((t) => t.table === 'tabs')!.upserts![0];
    expect(await rows('SELECT id, status, label FROM tabs WHERE org_id = ?', orgId)).toEqual([{ id: tab.id, status: tab.status, label: 'Tafel 4' }]);

    // Sent again (a retry): the same rows, nothing twice; the sequence never goes back.
    expect((await sync(key, 'batch', { ...VERSION, toSeq: 40, tables })).body).toEqual({ lastSeq: 42 });
    for (const t of tables) expect(await count(t.table, orgId), t.table).toBe(t.upserts!.length);
  });

  it('update rows to their new state and delete rows by key, composite keys included', async () => {
    const { orgId, key } = await replica(await seedOrg());
    const tables = await saleRows();
    await sync(key, 'batch', { ...VERSION, toSeq: 1, tables });
    const tab: Record<string, unknown> = { ...tables.find((t) => t.table === 'tabs')!.upserts![0], label: 'Terras 2' };
    const chargeLines = await rows<{ charge_id: string; line_id: string }>('SELECT charge_id, line_id FROM charge_lines WHERE org_id = ?', orgId);
    const res = await sync(key, 'batch', {
      ...VERSION,
      toSeq: 2,
      tables: [
        { table: 'tabs', upserts: [tab] },
        { table: 'org_counters', deletes: [['tab_number'], ['nothing-like-this']] },
        { table: 'charge_lines', deletes: chargeLines.map((l) => [l.charge_id, l.line_id]) },
        { table: 'organizations', upserts: [{ name: 'Nieuwe naam', locale: 'en', staff_required: 1, receipts_enabled: 0, blind_count: 1 }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(await rows('SELECT label FROM tabs WHERE id = ?', tab.id)).toEqual([{ label: 'Terras 2' }]);
    expect(await count('charge_lines', orgId)).toBe(0);
    expect(await rows("SELECT name FROM org_counters WHERE org_id = ? AND name = 'tab_number'", orgId)).toEqual([]);
    expect(await rows('SELECT name, locale, blind_count FROM organizations WHERE id = ?', orgId)).toEqual([{ name: 'Nieuwe naam', locale: 'en', blind_count: 1 }]);
  });

  it('re-encrypt payment credentials with this installation\'s own key for the org', async () => {
    const { orgId, key } = await replica(await seedOrg());
    const config = { merchantCode: 'M1', apiKey: 'sup3r-secret' };
    expect((await sync(key, 'batch', { ...VERSION, toSeq: 1, tables: [{ table: 'payment_provider_credentials', upserts: [{ provider: 'sumup', updated_at: '2026-11-15T10:00:00Z', config }] }] })).status).toBe(200);
    const [row] = await rows<{ config_ciphertext: string; config_iv: string }>('SELECT config_ciphertext, config_iv FROM payment_provider_credentials WHERE org_id = ?', orgId);
    expect(row.config_ciphertext).not.toContain('sup3r');
    const dek = (await getOrgDataKey(env, orgId))!;
    expect(JSON.parse(await decryptWithKey({ ciphertext: row.config_ciphertext, iv: row.config_iv }, dek))).toEqual(config);
  });

  it("never touch another org: a row id or a reference of another org refuses the whole batch", async () => {
    const victim = await seedOrg();
    const victimTab = await createTab(victim, { label: 'Niet van jou', lines: [{ itemCode: 'cola', name: 'Cola', unitPriceCents: 300, quantity: 1 }] });
    const { orgId, key } = await replica(await seedOrg());
    const tables = await saleRows();
    const myTab = tables.find((t) => t.table === 'tabs')!.upserts![0];

    const overwrite = await sync(key, 'batch', { ...VERSION, toSeq: 1, tables: [{ table: 'tabs', upserts: [{ ...myTab, id: victimTab.id, label: 'Gekaapt' }] }] });
    expect(overwrite.status).toBe(409);
    expect(overwrite.body).toMatchObject({ code: 'sync_foreign_ids', refused: [{ table: 'tabs', id: victimTab.id }] });

    const order = tables.find((t) => t.table === 'orders')!.upserts![0];
    const pointing = await sync(key, 'batch', { ...VERSION, toSeq: 1, tables: [...tables.filter((t) => t.table !== 'orders'), { table: 'orders', upserts: [{ ...order, tab_id: victimTab.id }] }] });
    expect(pointing.body.code).toBe('sync_foreign_ids');

    // A delete only ever deletes this org's rows.
    expect((await sync(key, 'batch', { ...VERSION, toSeq: 1, tables: [{ table: 'tabs', deletes: [[victimTab.id]] }] })).status).toBe(200);

    expect(await rows('SELECT label FROM tabs WHERE id = ?', victimTab.id)).toEqual([{ label: 'Niet van jou' }]);
    expect(await count('tabs', orgId)).toBe(0);
  });

  it('refuse a malformed batch, an unknown table, a stranger, and too many statements', async () => {
    const { key } = await replica(await seedOrg());
    expect((await sync('wrong', 'batch', { ...VERSION, toSeq: 1, tables: [] })).status).toBe(401);
    expect((await sync(key, 'batch', { ...VERSION, toSeq: -1, tables: [] })).status).toBe(400);
    expect((await sync(key, 'batch', { ...VERSION, toSeq: 1, tables: [{ table: 'memberships', upserts: [{}] }] })).status).toBe(400);
    expect((await sync(key, 'batch', { ...VERSION, toSeq: 1, tables: [{ table: 'organizations', upserts: [{}, {}] }] })).status).toBe(400);
    const many = SYNC_TABLES.filter((t) => t.table !== 'organizations').map((t) => ({ table: t.table, upserts: [{}], deletes: [['x']] }));
    expect(many.length * 2).toBeGreaterThan(MAX_TABLE_STATEMENTS);
    expect((await sync(key, 'batch', { ...VERSION, toSeq: 1, tables: many })).body.code).toBe('sync_batch_too_large');
    // A heartbeat: nothing to apply, the link's time moves.
    expect((await sync(key, 'batch', { ...VERSION, toSeq: 0, tables: [] })).status).toBe(200);
  });

  it('fit the Workers Free budget at the most statements a batch may take', async () => {
    const { key } = await replica(await seedOrg());
    const tables = await saleRows();
    const withDeletes = tables.map((t) => ({ ...t }));
    let statements = withDeletes.length;
    for (const t of SYNC_TABLES) {
      if (statements >= MAX_TABLE_STATEMENTS) break;
      if (t.table === 'organizations') continue;
      const existing = withDeletes.find((x) => x.table === t.table);
      if (existing) existing.deletes = [t.key.map(() => 'gone')];
      else withDeletes.push({ table: t.table, deletes: [t.key.map(() => 'gone')] });
      statements++;
    }
    // As many as a sale's tables allow (every synced table with upserts or a delete).
    expect(statements).toBeGreaterThanOrEqual(35);
    // The suite enforces 50 queries per invocation (D1_QUERY_LIMIT).
    const res = await sync(key, 'batch', { ...VERSION, toSeq: 1, tables: withDeletes });
    expect(res.body).toEqual({ lastSeq: 1 });
  });
});

describe('a replica is read-only for people', () => {
  it('refuses the kassa and the console, keeps reading and its own members', async () => {
    const owner = await seedOrg();
    const { orgId, key } = await replica(owner);
    await sync(key, 'batch', { ...VERSION, toSeq: 1, tables: await saleRows() });
    const asAdmin = { user: owner.admin };

    const tab = await api('POST', `/organizations/${orgId}/tabs`, { ...asAdmin, body: { label: 'Nieuw', deviceId: 'd', deviceName: 'Toog' } });
    expect(tab.status).toBe(403);
    expect(tab.body.code).toBe('org_read_only');
    expect((await api('POST', `/organizations/${orgId}/catalogs`, { ...asAdmin, body: { name: 'Nieuw' } })).body.code).toBe('org_read_only');

    for (const path of ['/tabs', '/catalogs', '/tables', '/staff', '/events']) {
      expect((await api('GET', `/organizations/${orgId}${path}`, asAdmin)).status, path).toBe(200);
    }
    expect((await api('POST', `/organizations/${orgId}/members`, { ...asAdmin, body: { email: 'boekhouder@example.test', role: 'admin' } })).status).toBe(201);
  });
});

describe('the sync references', () => {
  it("name every foreign key between synced tables (the cloud checks them)", async () => {
    const synced = new Set(SYNC_TABLES.map((t) => t.table));
    for (const t of SYNC_TABLES) {
      const fks = await rows<{ table: string; from: string }>(`SELECT "table", "from" FROM pragma_foreign_key_list('${t.table}')`);
      const want = Object.fromEntries(fks.filter((f) => synced.has(f.table) && f.from !== t.orgColumn && f.table !== 'organizations' && t.columns.includes(f.from)).map((f) => [f.from, f.table]));
      expect(SYNC_REFS[t.table] ?? {}, t.table).toEqual(want);
    }
  });
});
