// Step 3d: sales report from order lines (revenue per product / category /
// VAT, voids subtracted, tips excluded), payments per method from the
// transactions ledger, and pre-tab legacy sales from their items JSON.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, chargeCash, confirmCharge, createTab, DEVICE, line, payCash, seedOrg, tabsPath, testMenu, type TestOrg } from './helpers';

const report = (org: TestOrg, from: string, to: string, user = org.admin) =>
  api('GET', `/organizations/${org.orgId}/reports/sales?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { user });

const hourAgo = () => new Date(Date.now() - 3600_000).toISOString();
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

// Steak (Eten, 12% VAT) on the org's test menukaart at 1800.
async function steakOnMenu(org: TestOrg) {
  const call = async (method: string, path: string, body: unknown) => (await api(method, path, { user: org.admin, body })).body;
  const menu = await testMenu(org);
  const category = await call('POST', `/organizations/${org.orgId}/catalog/categories`, { name: 'Eten' });
  const product = await call('POST', `/organizations/${org.orgId}/catalog/products`, { name: 'Steak', categoryId: category.id, vatRateBp: 1200 });
  await call('POST', `/organizations/${org.orgId}/catalogs/${menu.catalogId}/entries`, { sectionId: menu.sectionId, variantId: product.variants[0].id, priceCents: 1800 });
  return { catalogId: menu.catalogId, variantId: product.variants[0].id };
}

describe('reports: access', () => {
  it('is admin-only and validates the range', async () => {
    const org = await seedOrg();
    expect((await report(org, hourAgo(), inAnHour(), null as any)).status).toBe(401);
    expect((await report(org, hourAgo(), inAnHour(), org.cashier)).status).toBe(403);
    expect((await api('GET', `/organizations/${org.orgId}/reports/sales`, { user: org.admin })).status).toBe(400);
    expect((await report(org, 'gisteren', inAnHour())).status).toBe(400);
    expect((await report(org, inAnHour(), hourAgo())).status).toBe(400);
  });
});

describe('reports: sales', () => {
  it('reports revenue per product, category and VAT from closed tabs, net of voids and without tips', async () => {
    const org = await seedOrg();
    const steak = await steakOnMenu(org);
    const tab = await createTab(org, { lines: [line('bon', 'Bon', 100, 10)] });
    await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), {
      user: org.cashier,
      body: { ...DEVICE, catalogId: steak.catalogId, lines: [{ variantId: steak.variantId, quantity: 2 }] },
    });
    const withSteak = (await api('GET', tabsPath(org.orgId, `/${tab.id}`), { user: org.cashier })).body;
    const steakLine = withSteak.lines.find((l: any) => l.name === 'Steak');
    await api('POST', tabsPath(org.orgId, `/${tab.id}/lines/${steakLine.id}/void`), { user: org.cashier, body: { reason: 'test', quantity: 1 } });
    // 1000 bonnen + 1800 steak, paid with a 200 tip.
    const charge = await chargeCash(org, tab.id, 3000, { tipCents: 200 });
    await confirmCharge(org, charge.body.chargeId);

    const { status, body } = await report(org, hourAgo(), inAnHour());
    expect(status).toBe(200);
    expect(body.sales.tabCount).toBe(1);
    expect(body.sales.revenueCents).toBe(2800);
    expect(body.sales.byProduct).toEqual([
      { name: 'Steak', category: 'Eten', quantity: 1, revenueCents: 1800 },
      { name: 'Bon', category: null, quantity: 10, revenueCents: 1000 },
    ]);
    expect(body.sales.byCategory).toEqual([
      { category: 'Eten', quantity: 1, revenueCents: 1800 },
      { category: null, quantity: 10, revenueCents: 1000 },
    ]);
    // VAT included in the price: 1800 × 12/112 = 192.86 → 193.
    expect(body.sales.byVat).toEqual([
      { vatRateBp: 1200, revenueCents: 1800, vatCents: 193 },
      { vatRateBp: null, revenueCents: 1000, vatCents: 0 },
    ]);
    expect(body.payments).toEqual({ count: 1, amountCents: 3000, tipCents: 200, byMethod: [{ method: 'cash', count: 1, amountCents: 3000, tipCents: 200 }] });
  });

  it('leaves out tabs closed outside the range, and counts open tabs separately', async () => {
    const org = await seedOrg();
    const old = await createTab(org, { lines: [line('bon', 'Bon', 100, 5)] });
    await payCash(org, old.id, 500);
    await env.DB.prepare(`UPDATE tabs SET closed_at = '2020-01-01T12:00:00.000Z' WHERE id = ?`).bind(old.id).run();
    await env.DB.prepare(`UPDATE transactions SET completed_at = '2020-01-01T12:00:00.000Z' WHERE tab_id = ?`).bind(old.id).run();
    await createTab(org, { lines: [line('bon', 'Bon', 100, 3)] });

    const { body } = await report(org, hourAgo(), inAnHour());
    expect(body.sales).toMatchObject({ tabCount: 0, revenueCents: 0, byProduct: [] });
    expect(body.payments.count).toBe(0);
    expect(body.openTabs).toEqual({ count: 1, outstandingCents: 300 });

    const past = await report(org, '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
    expect(past.body.sales).toMatchObject({ tabCount: 1, revenueCents: 500 });
  });

  it('reports pre-tab (legacy) payments from their items JSON', async () => {
    const org = await seedOrg();
    const now = new Date().toISOString();
    for (const [amount, items] of [
      [350, { bon: 3, fooi: 50 }],
      [800, { fietstocht: 1 }],
    ] as const) {
      await env.DB.prepare(`INSERT INTO transactions (id, amount_cents, method, items, org_id, completed_at) VALUES (?, ?, 'cash', ?, ?, ?)`)
        .bind(crypto.randomUUID(), amount, JSON.stringify(items), org.orgId, now)
        .run();
    }
    const { body } = await report(org, hourAgo(), inAnHour());
    expect(body.legacy).toEqual({ count: 2, amountCents: 1150, items: { bon: 3, fooi: 50, fietstocht: 1 } });
    expect(body.payments).toMatchObject({ count: 2, amountCents: 1150 });
    expect(body.sales.revenueCents).toBe(0);
  });

  it("never includes another org's sales", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const tab = await createTab(other, { lines: [line('bon', 'Bon', 100, 5)] });
    await payCash(other, tab.id, 500);
    const { body } = await report(org, hourAgo(), inAnHour());
    expect([body.sales.revenueCents, body.payments.count, body.openTabs.count]).toEqual([0, 0, 0]);
  });
});

describe('transactions list: membership required', () => {
  it('401/403 without membership, and rows carry tipCents and tabId', async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const tab = await createTab(org, { lines: [line('bon', 'Bon', 100, 5)] });
    const charge = await chargeCash(org, tab.id, 600, { tipCents: 100 });
    await confirmCharge(org, charge.body.chargeId);

    expect((await api('GET', `/transactions?orgId=${org.orgId}`, { user: null })).status).toBe(401);
    expect((await api('GET', `/transactions?orgId=${org.orgId}`, { user: other.admin })).status).toBe(403);
    const res = await api('GET', `/transactions?orgId=${org.orgId}`, { user: org.cashier });
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ amountCents: 600, tipCents: 100, tabId: tab.id });
  });
});

describe('retired KV pricing', () => {
  it('no longer serves /settings or /verify-password', async () => {
    const org = await seedOrg();
    expect((await api('GET', '/settings', { user: org.admin })).status).toBe(404);
    expect((await api('POST', '/settings', { user: org.admin, body: {} })).status).toBe(404);
    expect((await api('POST', '/verify-password', { user: org.admin, body: { password: 'x' } })).status).toBe(404);
  });
});
