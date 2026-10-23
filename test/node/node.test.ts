// The backend self-hosted (SELF_HOSTING.md): the same Worker code on Node —
// its database as D1 on SQLite, brought up to date like the installer does,
// the payment poller's alarm in the process, its service bindings as HTTP —
// and a real flow through the API on it: an organisation (its own data
// key), a menu, a tab, paid in cash, closed.
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupDatabase, migrateDatabase, nodeEnv, openDatabase, resetDefaultLogin, restoreDatabase, start } from '../../src/node';
import worker from '../../src/index';
import { AlarmNamespace } from '../../src/node/alarms';
import { NodeD1Database } from '../../src/node/d1';
import { migrate } from '../../src/node/migrate';

const dir = mkdtempSync(path.join(tmpdir(), 'backend-'));
const KEY32 = Buffer.alloc(32, 7).toString('base64');

// Before an update the database is copied aside; a rollback puts it back —
// in Node, since the distroless image has no shell (node-main.ts).
describe('the database copied aside before an update, and put back on a rollback', () => {
  it('copies every file there is; puts that copy back, the files it had no copy of removed', () => {
    const db = path.join(mkdtempSync(path.join(tmpdir(), 'backup-')), 'backend.db')
    writeFileSync(db, 'v1')
    writeFileSync(`${db}-wal`, 'wal1')
    expect(backupDatabase(db, '0.1.70')).toEqual([db, `${db}-wal`])
    expect(readFileSync(`${db}.before-0.1.70`, 'utf8')).toBe('v1')
    // The new version changed it (and made a -shm).
    writeFileSync(db, 'v2')
    writeFileSync(`${db}-wal`, 'wal2')
    writeFileSync(`${db}-shm`, 'shm2')
    // A restart of that version: the copy from before it is kept, not overwritten with v2.
    expect(backupDatabase(db, '0.1.70')).toEqual([])
    expect(readFileSync(`${db}.before-0.1.70`, 'utf8')).toBe('v1')
    expect(restoreDatabase(db, '0.1.70')).toBe(true)
    expect(readFileSync(db, 'utf8')).toBe('v1')
    expect(readFileSync(`${db}-wal`, 'utf8')).toBe('wal1')
    expect(existsSync(`${db}-shm`)).toBe(false)
    // Moved back, not copied: a restart of the rollback doesn't put it back again.
    expect(existsSync(`${db}.before-0.1.70`)).toBe(false)
    writeFileSync(db, 'v1, used since')
    expect(restoreDatabase(db, '0.1.70')).toBe(false)
    expect(readFileSync(db, 'utf8')).toBe('v1, used since')
  });

  it('no copy of that version: nothing put back; no database yet: nothing copied; only a version as a name', () => {
    const db = path.join(mkdtempSync(path.join(tmpdir(), 'backup-')), 'backend.db')
    expect(backupDatabase(db, '0.1.70')).toEqual([])
    writeFileSync(db, 'v1')
    expect(restoreDatabase(db, '0.1.69')).toBe(false)
    expect(readFileSync(db, 'utf8')).toBe('v1')
    expect(() => backupDatabase(db, '../evil')).toThrow(/Not a version/)
    expect(() => restoreDatabase(db, 'a/b')).toThrow(/Not a version/)
  });
});

describe('migrations, like the installer', () => {
  const schema = "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE); CREATE TABLE t (a TEXT); INSERT INTO d1_migrations (name) VALUES ('0001_a.sql');";
  const m1 = { name: '0001_a.sql', sql: 'CREATE TABLE t (a TEXT);' };
  const m2 = { name: '0002_b.sql', sql: 'ALTER TABLE t ADD COLUMN b TEXT;' };

  it('a fresh database gets schema.sql; then only what it lacks, each with its record', () => {
    const db = new NodeD1Database(':memory:');
    expect(migrate(db, schema, [m1])).toEqual({ fresh: true, applied: [] });
    expect(migrate(db, schema, [m1, m2])).toEqual({ fresh: false, applied: ['0002_b.sql'] });
    expect(migrate(db, schema, [m1, m2])).toEqual({ fresh: false, applied: [] });
    expect(db.raw.prepare('SELECT name FROM d1_migrations ORDER BY name').all().map((r: any) => r.name)).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('a failing migration changes nothing and says which', () => {
    const db = new NodeD1Database(':memory:');
    migrate(db, schema, [m1]);
    expect(() => migrate(db, schema, [m1, { name: '0002_bad.sql', sql: 'ALTER TABLE t ADD COLUMN c TEXT; SELECT nope FROM nowhere;' }])).toThrow(/0002_bad\.sql/);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('t') WHERE name = 'c'").get()).toEqual({ n: 0 });
  });

  it('--reset-login clears the seeded default login provider (it re-seeds from the settings)', () => {
    const env = { BACKEND_DB: path.join(dir, 'reset.db') };
    const db = openDatabase(env);
    migrateDatabase(env, db);
    expect(resetDefaultLogin(db)).toBe(false);
    // The default login provider belongs to the 'default' organisation (seeded with it).
    db.raw.prepare("INSERT OR IGNORE INTO organizations (id, name, dek_ciphertext, dek_iv, created_at, created_by_sub) VALUES ('default', 'Default', 'x', 'y', '2026-10-16', 'seed')").run();
    db.raw.prepare("INSERT INTO identity_providers (org_id, issuer_url, client_id, client_secret_ciphertext, client_secret_iv, updated_at) VALUES ('default', 'https://old.test/', 'c', 'x', 'y', '2026-10-16')").run();
    expect(resetDefaultLogin(db)).toBe(true);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM identity_providers WHERE org_id = 'default'").get()).toEqual({ n: 0 });
  });

  it("the real schema.sql and migrations: fresh, then up to date", () => {
    const env = { BACKEND_DB: path.join(dir, 'real.db') };
    expect(migrateDatabase(env).fresh).toBe(true);
    expect(migrateDatabase(env)).toEqual({ fresh: false, applied: [] });
  });
});

describe('the alarm, in the process', () => {
  it('rings once at its time; tried again when it throws', async () => {
    const rang: number[] = [];
    let fail = true;
    const ns = new AlarmNamespace((state) => ({
      fetch: async () => {
        await state.storage.setAlarm(Date.now() + 20);
        return new Response(null, { status: 204 });
      },
      alarm: async () => {
        rang.push(Date.now());
        if (fail) {
          fail = false;
          throw new Error('provider down');
        }
      },
    }));
    await ns.get(ns.idFromName('singleton')).fetch('https://poller/');
    const state = ns.instance('singleton').state;
    expect(await state.storage.getAlarm()).not.toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    expect(rang).toHaveLength(1);
    // A failed alarm is scheduled again (30 s later).
    expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    await state.storage.deleteAlarm();
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

describe('the backend on Node', () => {
  const admin = { 'X-User-Sub': 'sub-admin', 'X-User-Issuer': 'https://issuer.test/', 'X-User-Name': 'Bert', 'X-User-Email': 'bert@scouts.test' };
  const calls: string[] = [];
  let services: http.Server;
  let env: ReturnType<typeof nodeEnv>['env'];
  let poller: ReturnType<typeof nodeEnv>['poller'];

  beforeAll(async () => {
    // devicehub and the mailer: record what they're asked.
    services = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
    services.listen(0, '127.0.0.1');
    await once(services, 'listening');
    const url = `http://127.0.0.1:${(services.address() as AddressInfo).port}`;
    const environment = {
      BACKEND_DB: path.join(dir, 'api.db'),
      DEVICEHUB_URL: url,
      MAILER_URL: url,
      INTERNAL_API_KEY: 'k1',
      MAILER_INTERNAL_KEY: 'k2',
      ENCRYPTION_KEY: KEY32,
      PUBLIC_BASE_URL: 'https://arcanum.test',
      ORG_CREATION: 'admins',
      INSTANCE_ADMIN_EMAILS: '*@scouts.test',
      DEFAULT_IDP_ISSUER_URL: 'https://issuer.test/',
    };
    migrateDatabase(environment);
    ({ env, poller } = nodeEnv(environment, openDatabase(environment)));
  });
  afterAll(() => services.close());

  const api = async (method: string, p: string, body?: unknown) => {
    const res = await worker.fetch(new Request(`https://backend${p}`, { method, headers: { 'Content-Type': 'application/json', ...admin }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  it('an organisation, a menu, a tab paid in cash - closed; devicehub told', async () => {
    const org = await api('POST', '/organizations', { name: 'Scouts' });
    expect(org.status).toBe(201);
    const o = `/organizations/${org.body.id}`;
    const catalog = (await api('POST', `${o}/catalogs`, { name: 'Fuif' })).body;
    const section = (await api('POST', `${o}/catalogs/${catalog.id}/sections`, { name: 'Drank' })).body;
    const product = (await api('POST', `${o}/catalog/products`, { name: 'Pils', variants: [{ name: '', code: 'pils' }] })).body;
    await api('POST', `${o}/catalogs/${catalog.id}/entries`, { sectionId: section.id, variantId: product.variants[0].id, priceCents: 250 });
    const tab = await api('POST', `${o}/tabs`, { catalogId: catalog.id, deviceId: 'd1', deviceName: 'Toog', lines: [{ variantId: product.variants[0].id, quantity: 2 }] });
    expect(tab.status).toBe(201);
    expect(tab.body.outstandingCents).toBe(500);

    const charge = await api('POST', '/sumup/charge', { orgId: org.body.id, method: 'cash', tabId: tab.body.id, amount: 500, deviceId: 'd1', deviceName: 'Toog' });
    expect(charge.status).toBe(201);
    await api('POST', '/sumup/confirm', { chargeId: charge.body.chargeId, success: true });
    expect((await api('GET', `${o}/tabs/${tab.body.id}`)).body.status).toBe('closed');
    // The payment's poller was armed (the backstop for every charge).
    expect(await poller.instance('singleton').state.storage.getAlarm()).not.toBeNull();
    await poller.instance('singleton').state.storage.deleteAlarm();
    // waitUntil's work reached devicehub over HTTP.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toContain('POST /devices/tabs-changed');
  });

  it('served over HTTP too', async () => {
    const server = start({ ...process.env, PORT: '0', BACKEND_DB: path.join(dir, 'api.db'), DEVICEHUB_URL: 'http://127.0.0.1:1', MAILER_URL: 'http://127.0.0.1:1', INTERNAL_API_KEY: 'k1', MAILER_INTERNAL_KEY: 'k2', ENCRYPTION_KEY: KEY32, PUBLIC_BASE_URL: 'https://arcanum.test' });
    await once(server, 'listening');
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/organizations`, { headers: admin });
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(1);
    server.close();
  });
});
