// POST /internal/demo-orgs (HOSTING_PLAN.md section 2): the demo instance's
// only way to a new org — the bootstrapper's bearer key, ORG_CREATION=internal,
// one live demo per person, a cap on live demos, a seeded menukaart, and an
// admin membership bound to (issuer, sub) so the person lands straight in it.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, apiWith, DEVICE, rows, type TestUser } from './helpers';

const ISSUER = 'https://issuer.test/';
const KEY = 'test-bootstrap-key';
const internal = { ORG_CREATION: 'internal' };
const bearer = (key = KEY) => ({ Authorization: `Bearer ${key}` });

const person = (name = 'Bert'): TestUser => {
  const sub = `guest-${crypto.randomUUID()}`;
  return { sub, issuer: ISSUER, name, email: `${sub}@guest.invalid` };
};

function demo(body: Record<string, unknown>, options: { overrides?: Record<string, string | undefined>; headers?: Record<string, string> } = {}) {
  return apiWith({ ...internal, ...options.overrides }, 'POST', '/internal/demo-orgs', { body, headers: options.headers ?? bearer() });
}

const demoFor = (p: TestUser, extra: Record<string, unknown> = {}, overrides?: Record<string, string | undefined>) =>
  demo({ sub: p.sub, email: p.email, name: p.name, ...extra }, { overrides });


describe('POST /internal/demo-orgs — access', () => {
  it('answers 503 while the login provider is not configured (its issuer is what `sub` belongs to)', async () => {
    const res = await demoFor(person(), {}, { DEFAULT_IDP_ISSUER_URL: undefined });
    expect(res.status).toBe(503);
  });

  it('needs the bootstrap key', async () => {
    const p = person();
    const body = { sub: p.sub, email: p.email };
    expect((await demo(body, { headers: {} })).status).toBe(401);
    expect((await demo(body, { headers: bearer('wrong') })).status).toBe(401);
    expect((await demo(body, { headers: bearer(`${KEY}x`) })).status).toBe(401);
    // No key configured: nothing gets in, not even an empty bearer.
    expect((await demo(body, { headers: bearer(''), overrides: { BOOTSTRAP_API_KEY: undefined } })).status).toBe(401);
    expect((await demo(body, { headers: { Authorization: 'Bearer ' }, overrides: { BOOTSTRAP_API_KEY: '' } })).status).toBe(401);
  });

  it('does not exist outside the demo instance, for other methods, or through the bff', async () => {
    const p = person();
    const body = { sub: p.sub, email: p.email };
    for (const mode of [undefined, 'admins', 'single']) {
      expect((await demo(body, { overrides: { ORG_CREATION: mode } })).status).toBe(404);
    }
    // arcanum-bff's proxy always adds X-Forwarded-By (and replaces Authorization with the session's token).
    expect((await demo(body, { headers: { ...bearer(), 'X-Forwarded-By': 'bff' } })).status).toBe(404);
    expect((await apiWith(internal, 'GET', '/internal/demo-orgs', { headers: bearer() })).status).toBe(404);
    expect((await apiWith(internal, 'POST', '/internal/other', { headers: bearer(), body })).status).toBe(404);
    // The suite runs as 'admins' (SELF): not there either.
    expect((await api('POST', '/internal/demo-orgs', { body })).status).toBe(404);
    expect(await rows('SELECT id FROM memberships WHERE user_sub = ?', p.sub)).toEqual([]);
  });

  it('wants a sub and an e-mail address', async () => {
    expect((await demo({ email: 'a@b.test' })).status).toBe(400);
    expect((await demo({ sub: '  ', email: 'a@b.test' })).status).toBe(400);
    expect((await demo({ sub: 'x', email: 'geen-adres' })).status).toBe(400);
    expect((await demo({ sub: 'x' })).status).toBe(400);
  });
});

describe('POST /internal/demo-orgs — the demo org', () => {
  it('creates a demo org with its person as active admin, seen in their org list with its demo info', async () => {
    const p = person('Bert');
    const before = Date.now();
    const res = await demoFor(p);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Demo van Bert', created: true });
    const expires = Date.parse(res.body.expiresAt) - before;
    expect(expires).toBeGreaterThan(4 * 3600_000 - 60_000);
    expect(expires).toBeLessThan(4 * 3600_000 + 60_000);

    const [org] = await rows<any>('SELECT * FROM organizations WHERE id = ?', res.body.orgId);
    expect([org.is_locked, org.locale, org.created_by_sub]).toEqual(['N', 'nl', p.sub]);
    expect(await rows('SELECT user_sub, issuer, invited_email, role, status FROM memberships WHERE org_id = ?', res.body.orgId)).toEqual([
      { user_sub: p.sub, issuer: ISSUER, invited_email: p.email, role: 'admin', status: 'active' },
    ]);

    // Their next login (same issuer + sub) lands in it — no invite to accept.
    const list = await api('GET', '/organizations', { user: p });
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: res.body.orgId, name: 'Demo van Bert', locale: 'nl' });
    expect(list.body[0].demo).toEqual({ expiresAt: res.body.expiresAt, installUrl: 'https://start.test' });
    const memberships = await api('GET', '/organizations/memberships', { user: p });
    expect(memberships.body).toEqual([{ orgId: res.body.orgId, orgName: 'Demo van Bert', orgLocale: 'nl', role: 'admin' }]);
  });

  it('seeds a default menukaart the console and kassa can use right away', async () => {
    const p = person();
    const { orgId } = (await demoFor(p)).body;
    const catalogs = (await api('GET', `/organizations/${orgId}/catalogs`, { user: p })).body;
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0]).toMatchObject({ name: 'Menukaart', isDefault: true });

    const kassa = (await api('GET', `/organizations/${orgId}/catalogs/default/kassa`, { user: p })).body;
    expect(kassa.sections.map((s: any) => s.name)).toEqual(['Drank', 'Eten', 'Bonnen']);
    const entries = kassa.sections.flatMap((s: any) => s.entries);
    expect(entries.length).toBeGreaterThanOrEqual(15);
    expect(entries.map((e: any) => e.name)).toEqual(expect.arrayContaining(['Pils (25 cl)', 'Pils (50 cl)', 'Koffie', 'Croque (ham-kaas)', 'Drankbon']));
    expect(entries.find((e: any) => e.name === 'Pils (50 cl)')).toMatchObject({ priceCents: 450, categoryName: 'Drank' });
    expect(entries.find((e: any) => e.name === 'Drankbon').quickQuantities).toEqual([5, 10, 20]);

    const categories = (await api('GET', `/organizations/${orgId}/catalog/categories`, { user: p })).body;
    expect(categories.map((c: any) => c.name)).toEqual(['Drank', 'Eten', 'Bonnen']);
    const stations = (await api('GET', `/organizations/${orgId}/catalog/stations`, { user: p })).body;
    expect(stations.map((s: any) => s.name)).toEqual(['Bar', 'Keuken']);
    const products = (await api('GET', `/organizations/${orgId}/catalog/products`, { user: p })).body;
    expect(products.length).toBeGreaterThanOrEqual(8);
    const croque = products.find((x: any) => x.name === 'Croque');
    expect(croque.variants.map((v: any) => v.name)).toEqual(['ham-kaas', 'kaas']);
    expect(croque.vatRateBp).toBe(1200);
    expect(croque.prepStationId).toBe(stations.find((s: any) => s.name === 'Keuken').id);

    // And it sells: a tab with seeded lines, priced from the menukaart.
    const pils = entries.find((e: any) => e.name === 'Pils (25 cl)');
    const tab = await api('POST', `/organizations/${orgId}/tabs`, { user: p, body: { ...DEVICE, catalogId: kassa.id, lines: [{ variantId: pils.variantId, quantity: 4 }] } });
    expect(tab.status, JSON.stringify(tab.body)).toBe(201);
    expect(tab.body.totalCents).toBe(1000);
  });

  it("names and seeds it in the person's language", async () => {
    const fr = person('Anne');
    const res = await demoFor(fr, { locale: 'fr' });
    expect(res.body.name).toBe('Démo de Anne');
    const kassa = (await api('GET', `/organizations/${res.body.orgId}/catalogs/default/kassa`, { user: fr })).body;
    expect(kassa.name).toBe('Carte');
    expect(kassa.sections.flatMap((s: any) => s.entries).map((e: any) => e.name)).toContain('Vin (rouge)');
    expect((await rows<any>('SELECT locale FROM organizations WHERE id = ?', res.body.orgId))[0].locale).toBe('fr');

    const en = await demo({ sub: `s-${crypto.randomUUID()}`, email: 'x@y.test', locale: 'en' });
    expect(en.body.name).toBe('Demo');
    // Unknown language: Dutch.
    const other = await demo({ sub: `s-${crypto.randomUUID()}`, email: 'x@y.test', locale: 'de' });
    expect(other.body.name).toBe('Demo');
    expect((await rows<any>('SELECT locale FROM organizations WHERE id = ?', other.body.orgId))[0].locale).toBe('nl');
  });

  it('gives a person their live demo again instead of a second one', async () => {
    const p = person();
    const first = await demoFor(p);
    const again = await demoFor(p, { name: 'Iemand anders' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ orgId: first.body.orgId, name: first.body.name, expiresAt: first.body.expiresAt, created: false, pairingCode: expect.any(String) });
    expect(await rows('SELECT id FROM memberships WHERE user_sub = ?', p.sub)).toHaveLength(1);

    // Simultaneous clicks: still one.
    const q = person();
    const both = await Promise.all([demoFor(q), demoFor(q)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(new Set(both.map((r) => r.body.orgId)).size).toBe(1);

    // Once it has expired (the cleaner deletes it shortly), a new one.
    await env.DB.prepare('UPDATE organizations SET created_at = ? WHERE id = ?').bind(new Date(Date.now() - 5 * 3600_000).toISOString(), first.body.orgId).run();
    const fresh = await demoFor(p);
    expect(fresh.status).toBe(201);
    expect(fresh.body.orgId).not.toBe(first.body.orgId);
  });

  it('refuses a new demo with demo_limit_reached (429) once DEMO_MAX_LIVE are live — but still reopens your own', async () => {
    const mine = person();
    await demoFor(mine);
    const [{ n }] = await rows<{ n: number }>("SELECT COUNT(*) AS n FROM organizations WHERE is_locked = 'N'");
    const cap = { DEMO_MAX_LIVE: String(n) };

    const refused = await demoFor(person(), {}, cap);
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('demo_limit_reached');
    expect((await demoFor(mine, {}, cap)).status).toBe(200);

    expect((await demoFor(person(), {}, { DEMO_MAX_LIVE: String(n + 1) })).status).toBe(201);
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM organizations WHERE is_locked = 'N'"))[0].n).toBe(n + 1);
    // Refused means nothing was written.
    expect(await rows("SELECT id FROM categories WHERE org_id NOT IN (SELECT id FROM organizations)")).toEqual([]);
  });

  it("comes with a pairing code for its 'Kassa 1': single use, claimed by its person, a fresh one on every call", async () => {
    const p = person();
    const res = await demoFor(p);
    expect(res.body.pairingCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const claimed = await api('POST', '/organizations/device-pairings/claim', { user: p, body: { code: res.body.pairingCode } });
    expect(claimed.status).toBe(201);
    expect(claimed.body).toMatchObject({ role: 'pos', name: 'Kassa 1', orgId: res.body.orgId });
    expect((await api('POST', '/organizations/device-pairings/claim', { user: p, body: { code: res.body.pairingCode } })).body.code).toBe('pairing_code_invalid');
    // Their demo again (another browser, a second click): a new code.
    const again = await demoFor(p);
    expect(again.body.pairingCode).not.toBe(res.body.pairingCode);
    // Nobody outside the demo org can use it.
    expect((await api('POST', '/organizations/device-pairings/claim', { user: person(), body: { code: again.body.pairingCode } })).body.code).toBe('pairing_not_member');
    // In the demo's language.
    const fr = await demoFor(person(), { locale: 'fr' });
    expect(await rows('SELECT name, created_by FROM device_pairings WHERE org_id = ?', fr.body.orgId)).toEqual([{ name: 'Caisse 1', created_by: 'Demo' }]);
  });

  it('stays far inside the Free-plan query budget', async () => {
    // Whatever the menu's size, a fixed handful of statements — the suite's
    // limit is 50; this holds it to 15.
    const res = await demoFor(person(), {}, { D1_QUERY_LIMIT: '15' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
