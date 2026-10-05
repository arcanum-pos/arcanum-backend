// ORG_CREATION (HOSTING_PLAN.md section 1): who may create or import an org
// in each kind of installation, what GET /organizations/capabilities tells
// the console, and the `demo` field on every organization JSON. Single mode
// needs an installation without orgs — see org-creation-single.test.ts.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, apiWith, rows, seedOrg, type TestUser } from './helpers';

const user = (email: string): TestUser => ({ sub: `u-${crypto.randomUUID()}`, issuer: 'https://issuer.test/', name: 'X', email });
// The suite's allowlist is *@test, boss@example.test.
const instanceAdmin = () => user(`admin-${crypto.randomUUID()}@test`);
const outsider = () => user('stranger@elsewhere.example');

const MANIFEST = { format: 'arcanum-org-export', version: 1, organization: { name: 'Geïmporteerd' }, counts: {} };

describe('admins (the default)', () => {
  it('is what an unset or unknown ORG_CREATION means', async () => {
    for (const value of [undefined, '', 'everyone']) {
      const res = await apiWith({ ORG_CREATION: value }, 'GET', '/organizations/capabilities', { user: instanceAdmin() });
      expect(res.body).toEqual({ orgCreation: 'admins', canCreateOrganization: true, canImportOrganization: true, instanceAdmin: true });
    }
  });

  it('lets an instance admin create and import any number of orgs; anyone else gets not_instance_admin', async () => {
    const admin = instanceAdmin();
    await seedOrg();
    expect((await api('POST', '/organizations', { user: admin, body: { name: 'Eén' } })).status).toBe(201);
    expect((await api('POST', '/organizations', { user: admin, body: { name: 'Twee' } })).status).toBe(201);
    expect((await api('POST', '/organizations/import/start', { user: admin, body: { manifest: MANIFEST } })).status).toBe(201);

    const stranger = outsider();
    const refused = await api('POST', '/organizations', { user: stranger, body: { name: 'Niet van ons' } });
    expect([refused.status, refused.body.code]).toEqual([403, 'not_instance_admin']);
    const importRefused = await api('POST', '/organizations/import/start', { user: stranger, body: { manifest: MANIFEST } });
    expect([importRefused.status, importRefused.body.code]).toEqual([403, 'not_instance_admin']);
    expect((await api('GET', '/organizations/capabilities', { user: stranger })).body).toEqual({
      orgCreation: 'admins',
      canCreateOrganization: false,
      canImportOrganization: false,
      instanceAdmin: false,
    });
  });

  it("instanceAdmin: only an address on the installation's admin list, not marked unverified — also on the demo, and never for everyone", async () => {
    const caps = async (overrides: Record<string, string | undefined>, who: TestUser, verified?: 'true' | 'false') =>
      (await apiWith(overrides, 'GET', '/organizations/capabilities', { user: who, headers: verified ? { 'X-User-Email-Verified': verified } : {} })).body.instanceAdmin;
    expect(await caps({ ORG_CREATION: 'internal' }, instanceAdmin(), 'true')).toBe(true);
    expect(await caps({ ORG_CREATION: 'internal' }, outsider(), 'true')).toBe(false); // a demo visitor
    expect(await caps({ ORG_CREATION: 'internal' }, instanceAdmin(), 'false')).toBe(false);
    // An empty list lets anyone create orgs (the old default) — but makes nobody an installation admin.
    expect(await caps({ INSTANCE_ADMIN_EMAILS: '' }, instanceAdmin())).toBe(false);
  });

  it('capabilities needs a logged-in caller, and is not read as an org id', async () => {
    expect((await api('GET', '/organizations/capabilities')).status).toBe(401);
    const res = await api('GET', '/organizations/capabilities', { user: instanceAdmin() });
    expect(res.status).toBe(200);
    expect(res.body.orgCreation).toBe('admins');
  });
});

describe('internal (the demo instance)', () => {
  const internal = { ORG_CREATION: 'internal' };

  it('refuses creating and importing for everyone, instance admins included, with org_creation_disabled', async () => {
    for (const caller of [instanceAdmin(), outsider()]) {
      const create = await apiWith(internal, 'POST', '/organizations', { user: caller, body: { name: 'Nee' } });
      expect([create.status, create.body.code]).toEqual([403, 'org_creation_disabled']);
      expect(create.body.error).toBe('Op deze installatie kunnen geen nieuwe organisaties aangemaakt worden');
      const start = await apiWith(internal, 'POST', '/organizations/import/start', { user: caller, body: { manifest: MANIFEST } });
      expect([start.status, start.body.code]).toEqual([403, 'org_creation_disabled']);
      expect((await apiWith(internal, 'GET', '/organizations/capabilities', { user: caller })).body).toMatchObject({
        orgCreation: 'internal',
        canCreateOrganization: false,
        canImportOrganization: false,
      });
    }
    expect((await apiWith(internal, 'POST', '/organizations', { body: { name: 'Nee' } })).status).toBe(401);
  });

  it('still lets members use and invite into existing orgs', async () => {
    const org = await seedOrg();
    expect((await apiWith(internal, 'GET', `/organizations/${org.orgId}`, { user: org.admin })).status).toBe(200);
    const invite = await apiWith(internal, 'POST', `/organizations/${org.orgId}/members`, { user: org.admin, body: { email: 'nieuw@example.test', role: 'cashier' } });
    expect(invite.status).toBe(201);
  });
});

describe('demo info on the organization JSON', () => {
  async function lockedOrg(isLocked: string | null, createdAt: string) {
    const org = await seedOrg();
    await env.DB.prepare('UPDATE organizations SET is_locked = ?, created_at = ? WHERE id = ?').bind(isLocked, createdAt, org.orgId).run();
    return org;
  }

  it('is null for an ordinary org — in the list, the detail and a create response', async () => {
    const org = await seedOrg();
    const list = await api('GET', '/organizations', { user: org.admin });
    expect(list.body.find((o: any) => o.id === org.orgId).demo).toBeNull();
    expect((await api('GET', `/organizations/${org.orgId}`, { user: org.admin })).body.demo).toBeNull();
    const created = await api('POST', '/organizations', { user: instanceAdmin(), body: { name: 'Gewoon' } });
    expect(created.body.demo).toBeNull();

    // Only exactly 'N' is a demo (it's what arcanum-cleaner deletes).
    const kept = await lockedOrg('Y', '2026-09-30T10:00:00.000Z');
    expect((await api('GET', `/organizations/${kept.orgId}`, { user: kept.admin })).body.demo).toBeNull();
  });

  it("is { expiresAt: created_at + DEMO_LIFETIME_HOURS, installUrl } for a demo org", async () => {
    const org = await lockedOrg('N', '2026-09-30T10:15:00.000Z');
    const detail = await api('GET', `/organizations/${org.orgId}`, { user: org.admin });
    // The suite's DEMO_INSTALL_URL; DEMO_LIFETIME_HOURS from wrangler.jsonc (4).
    expect(detail.body.demo).toEqual({ expiresAt: '2026-09-30T14:15:00.000Z', installUrl: 'https://start.test' });
    const list = await api('GET', '/organizations', { user: org.admin });
    expect(list.body.find((o: any) => o.id === org.orgId).demo).toEqual(detail.body.demo);

    const other = await apiWith({ DEMO_LIFETIME_HOURS: '1.5', DEMO_INSTALL_URL: '' }, 'GET', `/organizations/${org.orgId}`, { user: org.admin });
    expect(other.body.demo).toEqual({ expiresAt: '2026-09-30T11:45:00.000Z', installUrl: null });
    // Unset or nonsense: 4 hours.
    for (const value of [undefined, 'veel', '0', '-2']) {
      const res = await apiWith({ DEMO_LIFETIME_HOURS: value }, 'GET', `/organizations/${org.orgId}`, { user: org.admin });
      expect(res.body.demo.expiresAt).toBe('2026-09-30T14:15:00.000Z');
    }
  });

  it('comes back from a branding update too', async () => {
    const org = await lockedOrg('N', '2026-09-30T10:00:00.000Z');
    const res = await api('PATCH', `/organizations/${org.orgId}/branding`, { user: org.admin, body: { name: 'Nieuwe naam' } });
    expect(res.body.demo.expiresAt).toBe('2026-09-30T14:00:00.000Z');
    expect(await rows('SELECT is_locked FROM organizations WHERE id = ?', org.orgId)).toEqual([{ is_locked: 'N' }]);
  });
});
