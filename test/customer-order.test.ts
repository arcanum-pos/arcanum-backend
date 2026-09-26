// The order a customer display shows for a charge: /sumup/status/:id
// carries the tab's name and its lines net of voids, so a CFD on another
// device can list the bestelling — not just the amount.
import { describe, expect, it } from 'vitest';
import { api, chargeCash, confirmCharge, createTab, DEVICE, line, orderBody, seedOrg, tabsPath } from './helpers';

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
      eventName: null,
      split: null,
      paidCents: 0,
      paying: null,
      lines: [
        { name: 'Bonnen', quantity: 10, unitPriceCents: 100 },
        { name: 'Fietstocht', quantity: 1, unitPriceCents: 800 },
      ],
    });
    expect(status.body.tipCents).toBe(200);

    // Still there once paid (the CFD's "Bedankt" follows the same status).
    await confirmCharge(org, charge.body.chargeId);
    expect((await api('GET', `/sumup/status/${charge.body.chargeId}`, { user: org.cashier })).body.order.lines).toHaveLength(2);
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
