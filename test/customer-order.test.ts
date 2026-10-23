// The order a customer display shows for a charge: /sumup/status/:id
// carries the tab's name and its lines net of voids, so a CFD on another
// device can list the bestelling — not just the amount.
import { describe, expect, it } from 'vitest';
import { api, chargeCash, confirmCharge, createTab, DEVICE, line, menuVariant, orderBody, seedOrg, tabsPath } from './helpers';

describe('customer order on the charge status', () => {
  it('lists the lines net of voids, fully voided ones left out', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 4', lines: [line('bon', 'Bonnen', 100, 10), line('fietstocht', 'Fietstocht', 800, 2), line('wandeltocht', 'Wandeltocht', 600, 1)] });
    const byCode = (code: string) => tab.lines.find((l: any) => l.itemCode === code);
    const voidLine = (lineId: string, quantity: number) =>
      api('POST', tabsPath(org.orgId, `/${tab.id}/lines/${lineId}/void`), { user: org.cashier, body: { ...DEVICE, reason: 'fout', quantity } });
    expect((await voidLine(byCode('fietstocht').id, 1)).status).toBe(201);
    expect((await voidLine(byCode('wandeltocht').id, 1)).status).toBe(201);

    const charge = await chargeCash(org, tab.id, 1800 + 200, { tipCents: 200 });
    expect(charge.status).toBe(201);
    const status = await api('GET', `/sumup/status/${charge.body.chargeId}`, { user: org.cashier });
    expect(status.body.order).toEqual({
      label: 'Tafel 4',
      number: tab.number,
      eventNumber: null,
      // Nothing to prepare (no prep stations): nothing to follow.
      followUrl: null,
      eventName: null,
      eventId: null,
      split: null,
      paidCents: 0,
      paying: null,
      lines: [
        { name: 'Bonnen', quantity: 10, unitPriceCents: 100, category: null },
        { name: 'Fietstocht', quantity: 1, unitPriceCents: 800, category: null },
      ],
    });
    expect(status.body.tipCents).toBe(200);

    // Still there once paid (the CFD's "Bedankt" follows the same status).
    await confirmCharge(org, charge.body.chargeId);
    expect((await api('GET', `/sumup/status/${charge.body.chargeId}`, { user: org.cashier })).body.order.lines).toHaveLength(2);
  });

  it("carries each line's category (the display counts items per category), also on a per-item payment", async () => {
    const org = await seedOrg();
    await menuVariant(org, 'pils', 'Pils', 250);
    await menuVariant(org, 'frieten', 'Frieten', 400);
    const products = (await api('GET', `/organizations/${org.orgId}/catalog/products`, { user: org.admin })).body as any[];
    for (const [product, name] of [['Pils', 'Drank'], ['Frieten', 'Eten']]) {
      const category = (await api('POST', `/organizations/${org.orgId}/catalog/categories`, { user: org.admin, body: { name } })).body;
      const id = products.find((p) => p.name === product).id;
      expect((await api('PATCH', `/organizations/${org.orgId}/catalog/products/${id}`, { user: org.admin, body: { categoryId: category.id } })).status).toBe(200);
    }
    const tab = await createTab(org, { label: 'Tafel 2', lines: [line('pils', 'Pils', 250, 3), line('frieten', 'Frieten', 400, 1)] });
    const pils = tab.lines.find((l: any) => l.name === 'Pils');
    const charge = await chargeCash(org, tab.id, 500, { lines: [{ lineId: pils.id, quantity: 2 }] });
    expect(charge.status).toBe(201);
    const { order } = (await api('GET', `/sumup/status/${charge.body.chargeId}`, { user: org.cashier })).body;
    expect(order.lines).toEqual([
      { name: 'Pils', quantity: 3, unitPriceCents: 250, category: 'Drank' },
      { name: 'Frieten', quantity: 1, unitPriceCents: 400, category: 'Eten' },
    ]);
    expect(order.paying).toEqual([{ name: 'Pils', quantity: 2, unitPriceCents: 250, category: 'Drank' }]);
  });

  it('a second order on the tab shows up too', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 5)] });
    await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), { user: org.cashier, body: await orderBody(org, { ...DEVICE, lines: [line('fietstocht', 'Fietstocht', 800, 1)] }) });
    const charge = await chargeCash(org, tab.id, 1300);
    const status = await api('GET', `/sumup/status/${charge.body.chargeId}`, { user: org.cashier });
    expect(status.body.order.lines.map((l: any) => l.name)).toEqual(['Bonnen', 'Fietstocht']);
  });
});
