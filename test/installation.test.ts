// Installation-level concerns for self-hosting (INSTALLER_PLAN.md phase 1):
// migration tracking, the fresh-install schema staying in step with the
// migrations, the admin allowlist, and no hardcoded kaboutersoft.be values.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { mayCreateOrganizations } from '../src/organizations/instance-admins';
import { api, rows, seedOrg, type TestUser } from './helpers';

const migrations = JSON.parse(env.TEST_MIGRATIONS) as { name: string; sql: string }[];

describe('migration tracking (wrangler d1_migrations)', () => {
  it('a fresh schema.sql database has every migration marked as applied', async () => {
    const applied = (await rows<{ name: string }>('SELECT name FROM d1_migrations ORDER BY id')).map((r) => r.name);
    expect(applied).toEqual(migrations.map((m) => m.name));
  });

  it('schema.sql contains everything the migrations add, and nothing they drop', async () => {
    // Replays what each migration creates/adds/drops, in order, and checks
    // the fresh-install schema ends up with the same objects — so a new
    // migration can't be forgotten in schema.sql.
    const tables = new Set<string>();
    const indexes = new Set<string>();
    const columns = new Set<string>(); // "table.column"
    for (const { sql } of migrations) {
      const clean = sql.replace(/--.*$/gm, '');
      for (const m of clean.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)) tables.add(m[1]);
      for (const m of clean.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/gi)) indexes.add(m[1]);
      for (const m of clean.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/gi)) columns.add(`${m[1]}.${m[2]}`);
      for (const m of clean.matchAll(/ALTER TABLE (\w+) DROP COLUMN (\w+)/gi)) columns.delete(`${m[1]}.${m[2]}`);
      for (const m of clean.matchAll(/DROP INDEX IF EXISTS (\w+)/gi)) indexes.delete(m[1]);
      for (const m of clean.matchAll(/DROP TABLE IF EXISTS (\w+)/gi)) tables.delete(m[1]);
    }
    expect(columns.size).toBeGreaterThan(10);

    const objects = await rows<{ type: string; name: string }>(`SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index')`);
    const have = (type: string) => new Set(objects.filter((o) => o.type === type).map((o) => o.name));
    expect([...tables].filter((t) => !have('table').has(t))).toEqual([]);
    expect([...indexes].filter((i) => !have('index').has(i))).toEqual([]);
    const missing: string[] = [];
    for (const tc of columns) {
      const [table, column] = tc.split('.');
      const cols = (await rows<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map((r) => r.name);
      if (!cols.includes(column)) missing.push(tc);
    }
    expect(missing).toEqual([]);
  });
});

describe('admin allowlist (INSTANCE_ADMIN_EMAILS)', () => {
  const user = (email: string): TestUser => ({ sub: `u-${crypto.randomUUID()}`, issuer: 'https://issuer.test/', name: 'X', email });

  it('allows everyone when unset (the shared platform)', () => {
    expect(mayCreateOrganizations({ ...env, INSTANCE_ADMIN_EMAILS: undefined } as any, 'anyone@anywhere.example')).toBe(true);
    expect(mayCreateOrganizations({ ...env, INSTANCE_ADMIN_EMAILS: ' ' } as any, 'anyone@anywhere.example')).toBe(true);
  });

  it('matches exact addresses and *@domain entries, case-insensitively', () => {
    const e = { ...env, INSTANCE_ADMIN_EMAILS: 'Boss@Example.test, *@scouts.test' } as any;
    expect(mayCreateOrganizations(e, 'boss@example.test')).toBe(true);
    expect(mayCreateOrganizations(e, 'leiding@SCOUTS.test')).toBe(true);
    expect(mayCreateOrganizations(e, 'boss@example.test.evil')).toBe(false);
    expect(mayCreateOrganizations(e, 'someone@example.test')).toBe(false);
    expect(mayCreateOrganizations(e, '')).toBe(false);
  });

  it('refuses creating or importing an org for anyone else (403), but not joining one', async () => {
    // The test config allows *@test and boss@example.test.
    const outsider = user('stranger@elsewhere.example');
    expect((await api('POST', '/organizations', { user: outsider, body: { name: 'Niet van ons' } })).status).toBe(403);
    const start = await api('POST', '/organizations/import/start', {
      user: outsider,
      body: { manifest: { format: 'arcanum-org-export', version: 1, organization: { name: 'X' }, counts: {} } },
    });
    expect(start.status).toBe(403);

    expect((await api('POST', '/organizations', { user: user('boss@example.test'), body: { name: 'Wel van ons' } })).status).toBe(201);

    // The allowlist is only about creating orgs: an outsider can still be
    // invited into an existing one.
    const org = await seedOrg();
    const invite = await api('POST', `/organizations/${org.orgId}/members`, { user: org.admin, body: { email: outsider.email, role: 'cashier' } });
    expect(invite.status).toBe(201);
  });
});

describe('no hardcoded installation values', () => {
  it("offers the installation's own hostname as the custom-domain CNAME target", async () => {
    const org = await seedOrg();
    const res = await api('GET', `/organizations/${org.orgId}/custom-domain`, { user: org.admin });
    expect(res.body.cnameTarget).toBe(new URL(env.PUBLIC_BASE_URL).hostname);
  });
});
