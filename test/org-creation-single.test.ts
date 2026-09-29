// ORG_CREATION=single (an own instance): an instance admin may create or
// import the first org, then nobody may add another. Its own file because it
// needs an installation without orgs — each test file gets its own storage.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureDefaultOrganizationRow } from '../src/organizations/idp-resolution';
import { apiWith, rows, type TestUser } from './helpers';

const single = { ORG_CREATION: 'single' };
const user = (email: string): TestUser => ({ sub: `u-${crypto.randomUUID()}`, issuer: 'https://issuer.test/', name: 'X', email });
const MANIFEST = { format: 'arcanum-org-export', version: 1, organization: { name: 'Meegenomen demo' }, counts: {} };

const capabilities = async (caller: TestUser) => (await apiWith(single, 'GET', '/organizations/capabilities', { user: caller })).body;
const create = (caller: TestUser, name = 'Onze club') => apiWith(single, 'POST', '/organizations', { user: caller, body: { name } });
const startImport = (caller: TestUser) => apiWith(single, 'POST', '/organizations/import/start', { user: caller, body: { manifest: MANIFEST } });

async function removeOrg(orgId: string) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM memberships WHERE org_id = ?').bind(orgId),
    env.DB.prepare('DELETE FROM organizations WHERE id = ?').bind(orgId),
  ]);
}

describe('single (an own instance)', () => {
  const owner = user('owner@test');
  const stranger = user('stranger@elsewhere.example');

  it('allows the first org only, created or imported, and only for an instance admin', async () => {
    // The platform 'default' row (login provider / mail fallback) isn't an org of anyone's.
    await ensureDefaultOrganizationRow(env);
    expect(await rows("SELECT id FROM organizations WHERE id != 'default'")).toEqual([]);

    expect(await capabilities(owner)).toEqual({ orgCreation: 'single', canCreateOrganization: true, canImportOrganization: true });
    expect(await capabilities(stranger)).toEqual({ orgCreation: 'single', canCreateOrganization: false, canImportOrganization: false });
    const refused = await create(stranger);
    expect([refused.status, refused.body.code]).toEqual([403, 'not_instance_admin']);

    // The first org may come from an import ("Neem je demo mee")...
    const imported = await startImport(owner);
    expect(imported.status).toBe(201);
    // ... and while it's there (even unfinished) nothing else can be added.
    expect(await capabilities(owner)).toEqual({ orgCreation: 'single', canCreateOrganization: false, canImportOrganization: false });
    for (const res of [await create(owner), await startImport(owner), await create(stranger)]) {
      expect([res.status, res.body.code]).toEqual([403, 'org_creation_disabled']);
    }

    // Aborting that import leaves the instance empty again.
    expect((await apiWith(single, 'POST', `/organizations/${imported.body.orgId}/import/abort`, { user: owner })).status).toBe(200);
    expect((await capabilities(owner)).canCreateOrganization).toBe(true);

    const created = await create(owner);
    expect(created.status).toBe(201);
    expect(created.body.demo).toBeNull();
    expect((await create(owner, 'Tweede')).body.code).toBe('org_creation_disabled');
    expect((await startImport(owner)).body.code).toBe('org_creation_disabled');
    // The owner is its admin, as with any create.
    const mine = await apiWith(single, 'GET', '/organizations', { user: owner });
    expect(mine.body.map((o: any) => o.id)).toEqual([created.body.id]);

    await removeOrg(created.body.id);
  });

  it('lets only one of two simultaneous first creates through', async () => {
    expect(await rows("SELECT id FROM organizations WHERE id != 'default'")).toEqual([]);
    const results = await Promise.all([create(owner, 'A'), create(owner, 'B'), startImport(owner)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
    expect(results.filter((r) => r.status === 403).every((r) => r.body.code === 'org_creation_disabled')).toBe(true);
    expect(await rows("SELECT id FROM organizations WHERE id != 'default'")).toHaveLength(1);
  });
});
