// Offline sync end to end (OFFLINE.md, phase 3, src/sync/push.ts): a box
// org (env.DB) linked to a backup on another installation (env.CLOUD_DB,
// the same Worker): the first sync, live changes, deletes, secrets, errors,
// the daily limit, the heartbeat, the loop.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../src';
import { decryptWithKey } from '../src/organizations/crypto';
import { getOrgDataKey } from '../src/organizations/organizations';
import { BATCH_ROWS, HEARTBEAT_MS, pushOnce, setSyncTransport, SyncPusher } from '../src/sync/push';
import { SYNC_TABLES } from '../src/sync/spec';
import { api, createTab, identityHeaders, payCash, rows, seedOrg, storePaymentConfig, type TestOrg } from './helpers';

const cloudEnv = () => ({ ...env, DB: env.CLOUD_DB, SYNC_SENDER: '' });

async function onCloud(method: string, path: string, user: TestOrg['admin'], body?: unknown) {
  const res = await worker.fetch(
    new Request(`https://arcanum.test${path}`, { method, headers: { 'Content-Type': 'application/json', ...identityHeaders(user) }, body: body === undefined ? undefined : JSON.stringify(body) }),
    cloudEnv() as any
  );
  return { status: res.status, body: (await res.json()) as any };
}

// The box reaches the cloud's Worker directly (the bff only passes it on).
let calls = 0;
function cloudTransport() {
  setSyncTransport(async (url, init) => {
    calls++;
    return worker.fetch(new Request(url, init), cloudEnv() as any);
  });
}
afterEach(() => setSyncTransport(null));

const cloudRows = async <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => ((await env.CLOUD_DB.prepare(sql).bind(...params).all<T>()).results ?? []) as T[];

async function boxWithSale() {
  const org = await seedOrg();
  const tab = await createTab(org, { label: 'Tafel 7', lines: [{ itemCode: 'cola', name: 'Cola', unitPriceCents: 300, quantity: 2 }] });
  await payCash(org, tab.id, 600);
  const open = await createTab(org, { label: 'Toog', lines: [{ itemCode: 'pils', name: 'Pils', unitPriceCents: 250, quantity: 1 }] });
  return { org, paidTabId: tab.id, openTabId: open.id };
}

async function linked(org: TestOrg) {
  cloudTransport();
  const invite = await onCloud('POST', '/organizations/backups', org.admin);
  expect(invite.status).toBe(201);
  const res = await api('POST', `/organizations/${org.orgId}/backup`, { user: org.admin, body: { code: invite.body.code } });
  expect(res.status).toBe(201);
  return res.body;
}

async function drain(orgId: string) {
  for (let i = 0; i < 50; i++) {
    const r = await pushOnce(env, orgId);
    if (r.kind === 'error') throw new Error(r.error);
    if (r.kind === 'idle' || !r.more) return;
  }
}

// Every synced row of the org, by table, as the box and the cloud have it.
async function snapshot(db: D1Database, orgId: string) {
  const out: Record<string, unknown[]> = {};
  for (const t of SYNC_TABLES) {
    if (t.secret) continue;
    const cols = t.columns.join(', ');
    out[t.table] = ((await db.prepare(`SELECT ${cols} FROM ${t.table} WHERE ${t.orgColumn} = ? ORDER BY ${cols}`).bind(orgId).all()).results ?? []);
  }
  return out;
}

describe('linking a box org to a backup', () => {
  it('makes the replica with the same org id, then the first sync makes it a copy', async () => {
    const { org, openTabId } = await boxWithSale();
    const status = await linked(org);
    expect(status).toMatchObject({ role: 'source', sends: true, remoteUrl: 'https://arcanum.test', firstSyncDoneAt: null });
    expect(status.pendingFirstSync).toBeGreaterThan(10);
    // Settings first, then what's open, then the history (foreign-key order within each).
    const order = (await rows<{ table_name: string; row_key: string }>('SELECT table_name, row_key FROM sync_outbox WHERE org_id = ? ORDER BY seq', org.orgId)).map((r) => `${r.table_name}:${r.row_key}`);
    expect(order[0]).toBe('organizations:[]');
    expect(order.indexOf(`tabs:["${openTabId}"]`)).toBeLessThan(order.findIndex((k) => k.startsWith('tabs:') && !k.includes(openTabId)));

    await drain(org.orgId);
    const box = await snapshot(env.DB, org.orgId);
    expect(Object.values(box).flat().length).toBeGreaterThan(15);
    expect(await snapshot(env.CLOUD_DB, org.orgId)).toEqual(box);
    const after = (await api('GET', `/organizations/${org.orgId}/backup`, { user: org.admin })).body;
    expect(after).toMatchObject({ pending: 0, pendingFirstSync: 0, lastError: null, firstSyncDoneAt: expect.any(String) });
    // On the cloud: a backup, read-only, its maker an admin.
    expect((await onCloud('GET', `/organizations/${org.orgId}/backup`, org.admin)).body).toMatchObject({ role: 'replica', sends: false });
    expect((await onCloud('POST', `/organizations/${org.orgId}/catalogs`, org.admin, { name: 'X' })).body.code).toBe('org_read_only');
  });

  it('refuses a wrong code, a second link, and a cloud on another release', async () => {
    const org = await seedOrg();
    cloudTransport();
    expect((await api('POST', `/organizations/${org.orgId}/backup`, { user: org.admin, body: { code: 'nope' } })).body.code).toBe('backup_code_invalid');
    expect((await api('POST', `/organizations/${org.orgId}/backup`, { user: org.cashier, body: { code: 'nope' } })).status).toBe(403);

    const invite = await onCloud('POST', '/organizations/backups', org.admin);
    setSyncTransport(async () => Response.json({ code: 'sync_version_mismatch' }, { status: 409 }));
    expect((await api('POST', `/organizations/${org.orgId}/backup`, { user: org.admin, body: { code: invite.body.code } })).body.code).toBe('backup_version_mismatch');
    setSyncTransport(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    expect((await api('POST', `/organizations/${org.orgId}/backup`, { user: org.admin, body: { code: invite.body.code } })).body.code).toBe('backup_unreachable');
    expect(await rows('SELECT 1 FROM sync_links WHERE org_id = ?', org.orgId)).toEqual([]);

    // A cloud installation only receives: its own org can't send a backup.
    expect((await onCloud('POST', `/organizations/${org.orgId}/backup`, org.admin, { code: invite.body.code })).body.code).toBe('backup_not_local');

    cloudTransport();
    expect((await api('POST', `/organizations/${org.orgId}/backup`, { user: org.admin, body: { code: invite.body.code } })).status).toBe(201);
    expect((await api('POST', `/organizations/${org.orgId}/backup`, { user: org.admin, body: { code: invite.body.code } })).body.code).toBe('backup_already_linked');
  });
});

describe('pushing changes', () => {
  it('sends new sales, changes and deletes as they happen', async () => {
    const { org, openTabId } = await boxWithSale();
    await linked(org);
    await drain(org.orgId);

    await payCash(org, openTabId, 250);
    const next = await createTab(org, { label: 'Terras', lines: [{ itemCode: 'cola', name: 'Cola', unitPriceCents: 300, quantity: 1 }] });
    await env.DB.prepare("INSERT INTO categories (id, org_id, name, position, created_at) VALUES ('cat-tmp', ?, 'Tijdelijk', 9, ?)").bind(org.orgId, new Date().toISOString()).run();
    await drain(org.orgId);
    await env.DB.prepare("DELETE FROM categories WHERE id = 'cat-tmp'").run();
    await drain(org.orgId);

    expect(await cloudRows('SELECT status FROM tabs WHERE id = ?', openTabId)).toEqual([{ status: 'closed' }]);
    expect(await cloudRows('SELECT label FROM tabs WHERE id = ?', next.id)).toEqual([{ label: 'Terras' }]);
    expect(await cloudRows("SELECT id FROM categories WHERE id = 'cat-tmp'")).toEqual([]);
    expect(await snapshot(env.CLOUD_DB, org.orgId)).toEqual(await snapshot(env.DB, org.orgId));
  });

  it('carries payment credentials decrypted and stores them under the cloud\'s own key', async () => {
    const org = await seedOrg();
    await storePaymentConfig(org, 'sumup', { merchantCode: 'M9', apiKey: 'k-secret' });
    await linked(org);
    await drain(org.orgId);
    const [row] = await cloudRows<{ config_ciphertext: string; config_iv: string }>('SELECT config_ciphertext, config_iv FROM payment_provider_credentials WHERE org_id = ?', org.orgId);
    const boxRow = (await rows<{ config_ciphertext: string }>('SELECT config_ciphertext FROM payment_provider_credentials WHERE org_id = ?', org.orgId))[0];
    expect(row.config_ciphertext).not.toBe(boxRow.config_ciphertext);
    const cloudKey = (await getOrgDataKey(cloudEnv() as any, org.orgId))!;
    expect(JSON.parse(await decryptWithKey({ ciphertext: row.config_ciphertext, iv: row.config_iv }, cloudKey))).toEqual({ merchantCode: 'M9', apiKey: 'k-secret' });
  });

  it('cuts a long outbox into batches', async () => {
    const org = await seedOrg();
    const now = new Date().toISOString();
    const many = Array.from({ length: BATCH_ROWS + 50 }, (_, i) => ({ id: crypto.randomUUID(), name: `C${i}`, position: i, created_at: now }));
    await env.DB.prepare(
      "INSERT INTO categories (id, org_id, name, position, created_at) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.name'), json_extract(value, '$.position'), json_extract(value, '$.created_at') FROM json_each(?)"
    ).bind(org.orgId, JSON.stringify(many)).run();
    await linked(org);
    calls = 0;
    const first = await pushOnce(env, org.orgId);
    expect(first).toEqual({ kind: 'sent', rows: BATCH_ROWS, more: true });
    await drain(org.orgId);
    expect(calls).toBe(2);
    expect((await cloudRows<{ n: number }>('SELECT COUNT(*) AS n FROM categories WHERE org_id = ?', org.orgId))[0].n).toBe(BATCH_ROWS + 50);
  });
});

describe('when it goes wrong', () => {
  it('keeps the changes and the error until the cloud takes them', async () => {
    const { org } = await boxWithSale();
    await linked(org);
    setSyncTransport(async () => {
      throw new Error('connect ETIMEDOUT');
    });
    expect(await pushOnce(env, org.orgId)).toMatchObject({ kind: 'error', error: expect.stringContaining('ETIMEDOUT') });
    const waiting = (await api('GET', `/organizations/${org.orgId}/backup`, { user: org.admin })).body;
    expect(waiting.lastError).toContain('ETIMEDOUT');
    expect(waiting.pending).toBeGreaterThan(0);

    // The kassa (a cashier, not only an admin) sees there's no internet.
    expect((await api('GET', `/organizations/${org.orgId}/backup/connection`, { user: org.cashier })).body).toMatchObject({ linked: true, online: false });

    cloudTransport();
    await drain(org.orgId);
    expect((await api('GET', `/organizations/${org.orgId}/backup`, { user: org.admin })).body).toMatchObject({ lastError: null, pending: 0 });
    expect((await api('GET', `/organizations/${org.orgId}/backup/connection`, { user: org.cashier })).body).toMatchObject({ linked: true, online: true });
  });

  it("says nothing about the internet for an org without a backup", async () => {
    const org = await seedOrg();
    expect((await api('GET', `/organizations/${org.orgId}/backup/connection`, { user: org.cashier })).body).toEqual({ linked: false, online: null, lastSyncAt: null });
    expect((await api('GET', `/organizations/${org.orgId}/backup/connection`, { user: null })).status).toBe(401);
  });

  it("waits for the next UTC day after the cloud's daily write limit", async () => {
    const org = await seedOrg();
    await linked(org);
    setSyncTransport(async () => Response.json({ code: 'sync_cloud_daily_limit' }, { status: 429 }));
    const now = Date.UTC(2026, 10, 15, 18, 30);
    expect(await pushOnce(env, org.orgId, now)).toEqual({ kind: 'error', error: 'sync_cloud_daily_limit', retryAt: Date.UTC(2026, 10, 16) });
  });

  it('the loop backs off after an error and goes on afterwards', async () => {
    const org = await seedOrg();
    await linked(org);
    let fail = true;
    setSyncTransport(async (url, init) => {
      calls++;
      if (fail) throw new Error('offline');
      return worker.fetch(new Request(url, init), cloudEnv() as any);
    });
    const pusher = new SyncPusher(env);
    const t0 = Date.now();
    calls = 0;
    await pusher.tick(t0);
    const failedCalls = calls;
    await pusher.tick(t0 + 1_000); // still waiting
    expect(calls).toBe(failedCalls);
    fail = false;
    await pusher.tick(t0 + 60_000);
    expect((await api('GET', `/organizations/${org.orgId}/backup`, { user: org.admin })).body).toMatchObject({ pending: 0, lastError: null });
  });
});

describe('the heartbeat', () => {
  it('says the box is alive when nothing changed for a while', async () => {
    const org = await seedOrg();
    await linked(org);
    await drain(org.orgId);
    const [{ last_sync_at: before }] = await cloudRows<{ last_sync_at: string }>('SELECT last_sync_at FROM sync_links WHERE org_id = ?', org.orgId);
    expect(await pushOnce(env, org.orgId, Date.now() + 1000)).toEqual({ kind: 'idle' });
    const later = Date.now() + HEARTBEAT_MS + 1000;
    expect(await pushOnce(env, org.orgId, later)).toMatchObject({ kind: 'sent', rows: 0 });
    const [{ last_sync_at: after }] = await cloudRows<{ last_sync_at: string }>('SELECT last_sync_at FROM sync_links WHERE org_id = ?', org.orgId);
    expect(after > before).toBe(true);
  });
});

describe('unlinking', () => {
  it('stops sending and empties the outbox; the cloud keeps its copy', async () => {
    const { org } = await boxWithSale();
    await linked(org);
    await drain(org.orgId);
    expect((await api('DELETE', `/organizations/${org.orgId}/backup`, { user: org.admin })).body).toMatchObject({ role: 'none' });
    await createTab(org, { label: 'Na', lines: [{ itemCode: 'cola', name: 'Cola', unitPriceCents: 300, quantity: 1 }] });
    expect(await rows('SELECT 1 FROM sync_outbox WHERE org_id = ?', org.orgId)).toEqual([]);
    expect((await cloudRows<{ n: number }>('SELECT COUNT(*) AS n FROM tabs WHERE org_id = ?', org.orgId))[0].n).toBe(2);
  });
});
