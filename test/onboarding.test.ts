// Easy onboarding: the example menukaart with a new organization (on request),
// added later from the console's "Aan de slag", and how far an org is.
import { describe, expect, it } from 'vitest';
import { api, apiWith, rows, seedOrg, type TestUser } from './helpers';

const user = (): TestUser => {
  const sub = `u-${crypto.randomUUID()}`;
  return { sub, issuer: 'https://issuer.test/', name: 'Els', email: `${sub}@test` };
};

const counts = async (orgId: string) => ({
  products: (await rows('SELECT id FROM products WHERE org_id = ?', orgId)).length,
  variants: (await rows('SELECT id FROM product_variants WHERE org_id = ?', orgId)).length,
  entries: (await rows('SELECT id FROM catalog_entries WHERE org_id = ?', orgId)).length,
  catalogs: await rows('SELECT name, is_default FROM catalogs WHERE org_id = ?', orgId),
});

describe('a new organization with the example menukaart', () => {
  it('comes with it in its own language when asked - the demo menukaart, ready for the kassa', async () => {
    const admin = user();
    const res = await api('POST', '/organizations', { user: admin, body: { name: 'Onze club', exampleMenu: true, locale: 'fr' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.locale).toBe('fr');
    const c = await counts(res.body.id);
    expect(c).toMatchObject({ products: 12, variants: 21, entries: 21, catalogs: [{ name: 'Carte', is_default: 1 }] });
    expect(await rows('SELECT name FROM categories WHERE org_id = ? ORDER BY position', res.body.id)).toEqual([{ name: 'Boissons' }, { name: 'Nourriture' }, { name: 'Jetons' }]);
  });

  it('and without asking, an empty one as before (in the default language)', async () => {
    const res = await api('POST', '/organizations', { user: user(), body: { name: 'Leeg' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await counts(res.body.id)).toMatchObject({ products: 0, catalogs: [] });
    expect(res.body.locale).toBe('nl');
  });

  it('nothing of the menukaart without its org: a refused create writes no rows', async () => {
    const before = (await rows('SELECT id FROM products')).length;
    const res = await apiWith({ ORG_CREATION: 'internal' }, 'POST', '/organizations', { user: user(), body: { name: 'Nee', exampleMenu: true } });
    expect(res.status).toBe(403);
    expect((await rows('SELECT id FROM products')).length).toBe(before);
  });

  it('stays far inside the Free-plan query budget', async () => {
    const res = await apiWith({ D1_QUERY_LIMIT: '15' }, 'POST', '/organizations', { user: user(), body: { name: 'Zuinig', exampleMenu: true, locale: 'en' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('"Aan de slag"', () => {
  it('says how far an organization is: menu, kassa, kassalade', async () => {
    const org = await seedOrg();
    const status = async () => (await api('GET', `/organizations/${org.orgId}/onboarding`, { user: org.admin })).body;
    expect(await status()).toEqual({ menu: false, kassa: false, register: false });

    expect((await api('POST', `/organizations/${org.orgId}/example-menu`, { user: org.admin, body: { locale: 'nl' } })).status).toBe(201);
    expect(await status()).toEqual({ menu: true, kassa: false, register: false });

    // A kassa pairing code counts once a device has claimed it.
    const pairing = await api('POST', `/organizations/${org.orgId}/device-pairings`, { user: org.admin, body: { role: 'pos', name: 'Kassa 1' } });
    expect(pairing.status, JSON.stringify(pairing.body)).toBe(201);
    expect((await status()).kassa).toBe(false);
    const claim = await api('POST', '/organizations/device-pairings/claim', { user: org.cashier, body: { code: pairing.body.code } });
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    expect((await status()).kassa).toBe(true);

    expect((await api('POST', `/organizations/${org.orgId}/registers`, { user: org.admin, body: { name: 'Kassalade 1' } })).status).toBe(201);
    expect(await status()).toEqual({ menu: true, kassa: true, register: true });
  });

  it('adds the example menukaart only into an empty organization, once - also with two clicks at once', async () => {
    const org = await seedOrg();
    const add = () => api('POST', `/organizations/${org.orgId}/example-menu`, { user: org.admin, body: {} });
    const [a, b] = await Promise.all([add(), add()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.code).toBe('menu_not_empty');
    // The org's language (none set: nl).
    expect(await counts(org.orgId)).toMatchObject({ products: 12, entries: 21, catalogs: [{ name: 'Menukaart', is_default: 1 }] });
  });

  it("never next to a menukaart of the org's own (one default), even an empty one", async () => {
    const org = await seedOrg();
    expect((await api('POST', `/organizations/${org.orgId}/catalogs`, { user: org.admin, body: { name: 'Zomer' } })).status).toBe(201);
    const res = await api('POST', `/organizations/${org.orgId}/example-menu`, { user: org.admin, body: {} });
    expect([res.status, res.body.code]).toEqual([409, 'menu_not_empty']);
    expect(await counts(org.orgId)).toMatchObject({ products: 0, catalogs: [{ name: 'Zomer', is_default: 1 }] });
  });

  it('is for admins only', async () => {
    const org = await seedOrg();
    expect((await api('GET', `/organizations/${org.orgId}/onboarding`, { user: org.cashier })).status).toBe(403);
    expect((await api('POST', `/organizations/${org.orgId}/example-menu`, { user: org.cashier, body: {} })).status).toBe(403);
    expect((await api('POST', `/organizations/${org.orgId}/example-menu`, { user: user(), body: {} })).status).toBe(403);
    expect((await api('GET', `/organizations/${org.orgId}/onboarding`, { user: null })).status).toBe(401);
    expect(await counts(org.orgId)).toMatchObject({ products: 0 });
  });
});
