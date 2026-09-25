// Tabs API: auth, numbering, orders, voids, cancel, rename, listing.
// Payment-related tab rules live in tab-payments.test.ts.
import { describe, expect, it } from 'vitest';
import { api, createTab, DEVICE, getTab, line, orderBody, payCash, seedOrg, tabsPath, type TestOrg } from './helpers';

async function tabWithOrder(org: TestOrg) {
  return createTab(org, {
    label: 'Toog',
    lines: [line('bon', 'Bonnen', 100, 10), line('pils', 'Pils', 150, 1)],
  });
}

describe('tabs: auth', () => {
  it('rejects a request without identity (401)', async () => {
    const org = await seedOrg();
    const res = await api('GET', tabsPath(org.orgId), { user: null });
    expect(res.status).toBe(401);
  });

  it('rejects a caller who is not a member of the org (403)', async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const res = await api('GET', tabsPath(other.orgId), { user: org.cashier });
    expect(res.status).toBe(403);
  });

  it('lets both cashiers and admins in', async () => {
    const org = await seedOrg();
    expect((await api('GET', tabsPath(org.orgId), { user: org.cashier })).status).toBe(200);
    expect((await api('GET', tabsPath(org.orgId), { user: org.admin })).status).toBe(200);
  });

  it("does not expose another org's tab through your own org path (404)", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const foreign = await createTab(other);
    const res = await api('GET', tabsPath(org.orgId, `/${foreign.id}`), { user: org.cashier });
    expect(res.status).toBe(404);
  });
});

describe('tabs: create', () => {
  it('creates a tab with a first order and computes totals', async () => {
    const org = await seedOrg();
    const tab = await tabWithOrder(org);
    expect(tab.totalCents).toBe(1150);
    expect(tab.outstandingCents).toBe(1150);
    expect(tab.status).toBe('open');
  });

  it('numbers the first tab of an org 1', async () => {
    const org = await seedOrg();
    expect((await createTab(org)).number).toBe(1);
  });

  it('attributes the order to the device from the body and the user from the session headers', async () => {
    const org = await seedOrg();
    const tab = await tabWithOrder(org);
    expect(tab.orders[0].deviceName).toBe(DEVICE.deviceName);
    expect(tab.orders[0].userName).toBe(org.cashier.name);
  });

  it('gives concurrently created tabs unique consecutive numbers', async () => {
    const org = await seedOrg();
    const tabs = await Promise.all(Array.from({ length: 8 }, (_, i) => createTab(org, { label: `T${i}` })));
    expect(tabs.map((t) => t.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('numbers tabs per org, independently', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await createTab(a);
    await createTab(a);
    expect((await createTab(b)).number).toBe(1);
  });
});

describe('tabs: order validation', () => {
  it('rejects an empty line list (400)', async () => {
    const org = await seedOrg();
    const tab = await createTab(org);
    const res = await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), { user: org.cashier, body: { lines: [] } });
    expect(res.status).toBe(400);
  });

  it('rejects a free line without a variant — prices only come from the menukaart (400)', async () => {
    const org = await seedOrg();
    const tab = await createTab(org);
    const res = await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), {
      user: org.cashier,
      body: { lines: [{ name: 'x', unitPriceCents: 100, quantity: 1 }] },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a zero quantity (400)', async () => {
    const org = await seedOrg();
    const tab = await createTab(org);
    const res = await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), {
      user: org.cashier,
      body: await orderBody(org, { lines: [line('x', 'x', 100, 0)] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('tabs: orders and voids', () => {
  async function tabWithFietstocht(org: TestOrg) {
    const tab = await tabWithOrder(org);
    const res = await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), {
      user: org.cashier,
      body: await orderBody(org, { ...DEVICE, lines: [line('fietstocht', 'Fietstocht', 800, 2)] }),
    });
    expect(res.status).toBe(201);
    const fiets = res.body.lines.find((l: any) => l.itemCode === 'fietstocht');
    return { tab: res.body, fiets };
  }

  const voidPath = (org: TestOrg, tabId: string, lineId: string) => tabsPath(org.orgId, `/${tabId}/lines/${lineId}/void`);

  it('adds an order to an open tab', async () => {
    const org = await seedOrg();
    const { tab } = await tabWithFietstocht(org);
    expect(tab.totalCents).toBe(2750);
    expect(tab.orders).toHaveLength(2);
  });

  it('requires a reason to void (400)', async () => {
    const org = await seedOrg();
    const { tab, fiets } = await tabWithFietstocht(org);
    const res = await api('POST', voidPath(org, tab.id, fiets.id), { user: org.cashier, body: { quantity: 1 } });
    expect(res.status).toBe(400);
  });

  it('voids part of a line as a new negative line, keeping the original', async () => {
    const org = await seedOrg();
    const { tab, fiets } = await tabWithFietstocht(org);
    const res = await api('POST', voidPath(org, tab.id, fiets.id), { user: org.cashier, body: { ...DEVICE, reason: 'verkeerd', quantity: 1 } });
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(1950);

    const original = res.body.lines.find((l: any) => l.id === fiets.id);
    const voidLine = res.body.lines.find((l: any) => l.voidsLineId === fiets.id);
    expect(original.quantity).toBe(2);
    expect(original.voidedQuantity).toBe(1);
    expect(voidLine.quantity).toBe(-1);
    expect(voidLine.voidReason).toBe('verkeerd');
  });

  it('voids whatever is left when no quantity is given', async () => {
    const org = await seedOrg();
    const { tab, fiets } = await tabWithFietstocht(org);
    const res = await api('POST', voidPath(org, tab.id, fiets.id), { user: org.cashier, body: { reason: 'weg' } });
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(1150);
  });

  it('refuses to void more than is left on the line (409)', async () => {
    const org = await seedOrg();
    const { tab, fiets } = await tabWithFietstocht(org);
    await api('POST', voidPath(org, tab.id, fiets.id), { user: org.cashier, body: { reason: 'x', quantity: 1 } });
    const res = await api('POST', voidPath(org, tab.id, fiets.id), { user: org.cashier, body: { reason: 'x', quantity: 2 } });
    expect(res.status).toBe(409);
  });

  it('cannot void a void line (404)', async () => {
    const org = await seedOrg();
    const { tab, fiets } = await tabWithFietstocht(org);
    const voided = await api('POST', voidPath(org, tab.id, fiets.id), { user: org.cashier, body: { reason: 'x', quantity: 1 } });
    const voidLine = voided.body.lines.find((l: any) => l.voidsLineId === fiets.id);
    const res = await api('POST', voidPath(org, tab.id, voidLine.id), { user: org.cashier, body: { reason: 'x' } });
    expect(res.status).toBe(404);
  });

  it('lets exactly one of several concurrent voids of the last unit through', async () => {
    const org = await seedOrg();
    const { tab, fiets } = await tabWithFietstocht(org);
    await api('POST', voidPath(org, tab.id, fiets.id), { user: org.cashier, body: { reason: 'x', quantity: 1 } });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => api('POST', voidPath(org, tab.id, fiets.id), { user: org.cashier, body: { reason: 'race', quantity: 1 } }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await getTab(org, tab.id)).totalCents).toBe(1150);
  });

  it('refuses an order on a closed tab (409)', async () => {
    const org = await seedOrg();
    const tab = await tabWithOrder(org);
    await payCash(org, tab.id, 1150);
    const res = await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), { user: org.cashier, body: await orderBody(org, { lines: [line('x', 'x', 100, 1)] }) });
    expect(res.status).toBe(409);
  });
});

describe('tabs: cancel', () => {
  const cancel = (org: TestOrg, tabId: string, reason?: string) =>
    api('POST', tabsPath(org.orgId, `/${tabId}/cancel`), { user: org.cashier, body: { reason } });

  it('refuses to cancel a tab with something on it (409)', async () => {
    const org = await seedOrg();
    const tab = await tabWithOrder(org);
    expect((await cancel(org, tab.id)).status).toBe(409);
  });

  it('cancels an empty tab without giving it a receipt number', async () => {
    const org = await seedOrg();
    const tab = await createTab(org);
    const res = await cancel(org, tab.id, 'per ongeluk');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.receiptNumber).toBeNull();
    expect(res.body.cancelReason).toBe('per ongeluk');
  });

  it('cancels a tab whose lines were all voided', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { lines: [line('bon', 'Bonnen', 100, 3)] });
    await api('POST', tabsPath(org.orgId, `/${tab.id}/lines/${tab.lines[0].id}/void`), { user: org.cashier, body: { reason: 'x' } });
    expect((await cancel(org, tab.id)).status).toBe(200);
  });
});

describe('tabs: list and rename', () => {
  it('lists open, closed and cancelled tabs separately', async () => {
    const org = await seedOrg();
    const paid = await tabWithOrder(org);
    await payCash(org, paid.id, 1150);
    const empty = await createTab(org);
    await api('POST', tabsPath(org.orgId, `/${empty.id}/cancel`), { user: org.cashier, body: {} });
    await createTab(org, { label: 'Tafel 4' });
    await createTab(org, { label: 'Jan' });

    const list = async (status: string) => (await api('GET', tabsPath(org.orgId, `?status=${status}`), { user: org.cashier })).body;
    expect((await list('open')).map((t: any) => t.label).sort()).toEqual(['Jan', 'Tafel 4']);
    expect(await list('closed')).toHaveLength(1);
    expect(await list('cancelled')).toHaveLength(1);
  });

  it('rejects an unknown status filter (400)', async () => {
    const org = await seedOrg();
    expect((await api('GET', tabsPath(org.orgId, '?status=paid'), { user: org.cashier })).status).toBe(400);
  });

  it('renames an open tab', async () => {
    const org = await seedOrg();
    const tab = await createTab(org);
    const res = await api('PATCH', tabsPath(org.orgId, `/${tab.id}`), { user: org.cashier, body: { label: 'Tafel 4' } });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Tafel 4');
  });

  it('returns 404 for an unknown tab', async () => {
    const org = await seedOrg();
    expect((await api('GET', tabsPath(org.orgId, '/does-not-exist'), { user: org.cashier })).status).toBe(404);
  });
});
