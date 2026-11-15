// Offline sync, the cloud's watch and promotion (OFFLINE.md, phase 5):
// src/sync/watch.ts warns a backup's admins when its box went silent for an
// hour; POST /organizations/:orgId/backup/promote makes a backup the org in use.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { parseLinkCode } from '../src/sync/replica';
import { SYNC_PROTOCOL, SYNC_SCHEMA } from '../src/sync/spec';
import { checkBackups, SILENCE_MS, SyncWatch } from '../src/sync/watch';
import { api, apiWith, recordedCalls, rows, seedOrg } from './helpers';

const VERSION = { protocol: SYNC_PROTOCOL, schema: SYNC_SCHEMA };
const MAIL = { MAIL_CONFIG: JSON.stringify({ provider: 'brevo', apiKey: 'xkeysib-test', fromAddress: 'noreply@scouts.test' }) };
const sync = (key: string, path: string, body: unknown) => apiWith({}, 'POST', `/sync/${path}`, { body, headers: { Authorization: `Bearer ${key}` } });

async function backup(locale = 'nl') {
  const owner = await seedOrg();
  const { key } = parseLinkCode((await api('POST', '/organizations/backups', { user: owner.admin })).body.code)!;
  const orgId = crypto.randomUUID();
  expect((await sync(key, 'hello', { ...VERSION, orgId, name: 'Kassa Elewijt', locale })).status).toBe(201);
  return { owner, orgId, key };
}

const warningsTo = async (email: string) => (await recordedCalls('mailer')).filter((c) => JSON.stringify(c.body).includes(email) && JSON.stringify(c.body).includes('reservekopie'));

describe('the watch', () => {
  it("mails a backup's admins once when its box has been silent for an hour", async () => {
    const { owner, orgId, key } = await backup();
    const mailEnv = { ...env, ...MAIL } as typeof env;
    await sync(key, 'batch', { ...VERSION, toSeq: 0, tables: [] });

    // Not yet: heard from just now.
    expect((await checkBackups(mailEnv)).warned).not.toContain(orgId);
    const later = Date.now() + SILENCE_MS + 60_000;
    expect((await checkBackups(mailEnv, later)).warned).toContain(orgId);
    const mails = await warningsTo(owner.admin.email);
    expect(mails).toHaveLength(1);
    expect(JSON.stringify(mails[0].body)).toContain('Kassa Elewijt');
    // Once: not again on the next run.
    expect((await checkBackups(mailEnv, later + 60_000)).warned).not.toContain(orgId);

    // The box is back: the next silence warns again.
    await sync(key, 'batch', { ...VERSION, toSeq: 0, tables: [] });
    expect(await rows('SELECT warned_at FROM sync_links WHERE org_id = ?', orgId)).toEqual([{ warned_at: null }]);
  });

  it('wakes up with the first backup, and keeps watching while there are backups', async () => {
    await backup();
    const stub = env.SYNC_WATCH.get(env.SYNC_WATCH.idFromName('sync-watch'));
    const alarm = await runInDurableObject(stub, (_: SyncWatch, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now());
  });
});

describe('promoting a backup', () => {
  it("makes it the org in use: people may change it, the old box's key no longer works", async () => {
    const { owner, orgId, key } = await backup();
    const promoteAs = (confirm: string) => api('POST', `/organizations/${orgId}/backup/promote`, { user: owner.admin, body: { confirm } });

    expect((await api('POST', `/organizations/${orgId}/catalogs`, { user: owner.admin, body: { name: 'Nieuw' } })).body.code).toBe('org_read_only');
    expect((await promoteAs('Kassa')).body.code).toBe('backup_confirm_name');
    expect((await promoteAs('Kassa Elewijt')).body).toMatchObject({ role: 'none' });

    expect((await api('POST', `/organizations/${orgId}/catalogs`, { user: owner.admin, body: { name: 'Nieuw' } })).status).toBe(201);
    expect((await sync(key, 'batch', { ...VERSION, toSeq: 1, tables: [] })).status).toBe(401);
    expect((await promoteAs('Kassa Elewijt')).body.code).toBe('backup_not_replica');
  });

  it('only by an admin of the backup', async () => {
    const { orgId } = await backup();
    const stranger = await seedOrg();
    expect((await api('POST', `/organizations/${orgId}/backup/promote`, { user: stranger.admin, body: { confirm: 'Kassa Elewijt' } })).status).toBe(403);
  });
});
