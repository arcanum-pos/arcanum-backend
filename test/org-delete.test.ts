// Deleting an organization (src/organizations/delete.ts): behind its name,
// admins only, in steps within the Free plan's query limit, every row of
// it gone and nobody else's touched - also a box org and a backup.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, createTab, payCash, recordedCalls, rows, seedOrg, type TestOrg } from './helpers';

const now = () => new Date().toISOString();

async function orgRows(orgId: string) {
  const tables = await rows<{ name: string }>(
    "SELECT name FROM sqlite_master m WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'org_id')"
  );
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    const [{ n }] = await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}" WHERE org_id = ?`, orgId);
    if (n) out[name] = n;
  }
  const [{ n }] = await rows<{ n: number }>('SELECT COUNT(*) AS n FROM organizations WHERE id = ?', orgId);
  if (n) out.organizations = n;
  return out;
}

async function withSale() {
  const org = await seedOrg();
  const tab = await createTab(org, { label: 'Tafel 1', lines: [{ itemCode: 'cola', name: 'Cola', unitPriceCents: 300, quantity: 2 }] });
  await payCash(org, tab.id, 600);
  await createTab(org, { label: 'Toog', lines: [{ itemCode: 'pils', name: 'Pils', unitPriceCents: 250, quantity: 1 }] });
  return org;
}

// What the console does: call again until done.
async function deleteAll(org: TestOrg) {
  for (let i = 1; i <= 6; i++) {
    const res = await api('DELETE', `/organizations/${org.orgId}`, { user: org.admin, body: { confirm: 'Test org' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return i;
  }
  throw new Error('not done after 6 steps');
}

describe('deleting an organization', () => {
  it('only by an admin, behind the exact name', async () => {
    const org = await seedOrg();
    expect((await api('DELETE', `/organizations/${org.orgId}`, { user: org.cashier, body: { confirm: 'Test org' } })).status).toBe(403);
    const wrong = await api('DELETE', `/organizations/${org.orgId}`, { user: org.admin, body: { confirm: 'Test' } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('org_confirm_name');
    expect(await orgRows(org.orgId)).toMatchObject({ organizations: 1, memberships: 2 });
  });

  it('removes every row of it, in steps, and leaves other orgs alone', async () => {
    const other = await withSale();
    const before = await orgRows(other.orgId);
    const org = await withSale();
    expect(Object.keys(await orgRows(org.orgId)).length).toBeGreaterThan(10);

    const steps = await deleteAll(org);
    expect(steps).toBeGreaterThanOrEqual(2);
    expect(await orgRows(org.orgId)).toEqual({});
    expect(await orgRows(other.orgId)).toEqual(before);
    expect((await recordedCalls('devicehub')).map((c) => c.path)).toContain(`/devices/by-org/${org.orgId}`);
    // Gone: its admin has nothing left to open.
    expect((await api('GET', `/organizations/${org.orgId}/backup`, { user: org.admin })).status).toBe(403);
  });

  it('a box org with a backup: its link goes first, so nothing is queued for the cloud', async () => {
    const org = await withSale();
    await env.DB.prepare("INSERT INTO sync_links (org_id, role, remote_url, created_at, last_seq) VALUES (?, 'source', 'https://cloud.test', ?, 0)").bind(org.orgId, now()).run();
    await env.DB.prepare("UPDATE organizations SET name = 'Test org' WHERE id = ?").bind(org.orgId).run();
    await deleteAll(org);
    expect(await orgRows(org.orgId)).toEqual({});
  });

  it('a backup on the cloud: read-only for changes, but it can be deleted', async () => {
    const org = await withSale();
    await env.DB.prepare("INSERT INTO sync_links (org_id, role, created_at, last_seq) VALUES (?, 'replica', ?, 0)").bind(org.orgId, now()).run();
    expect((await api('POST', `/organizations/${org.orgId}/catalogs`, { user: org.admin, body: { name: 'X' } })).body.code).toBe('org_read_only');
    await deleteAll(org);
    expect(await orgRows(org.orgId)).toEqual({});
  });
});
