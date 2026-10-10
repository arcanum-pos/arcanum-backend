// Korting: a product with a negative price lowers the tab's total. A tab is
// only paid while something is outstanding, so a discount can't pay out;
// one that brings the total to 0 can be cancelled, one below 0 must be
// voided first.
import { describe, expect, it } from 'vitest';
import { api, chargeCash, createTab, DEVICE, getTab, line, payCash, seedOrg, tabsPath } from './helpers';

const report = (org: Awaited<ReturnType<typeof seedOrg>>) => {
  const from = new Date(Date.now() - 3600_000).toISOString();
  const to = new Date(Date.now() + 3600_000).toISOString();
  return api('GET', `/organizations/${org.orgId}/reports/sales?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { user: org.admin });
};

describe('korting (a negative price)', () => {
  it('lowers the total; the tab is paid and closed for what remains; the report shows it as negative revenue', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('pils', 'Pils', 300, 2), line('korting', 'Korting', -100, 1)] });
    expect(tab.totalCents).toBe(500);
    expect(tab.outstandingCents).toBe(500);
    // Not more than what's left.
    expect((await chargeCash(org, tab.id, 600)).status).toBe(409);
    await payCash(org, tab.id, 500);
    expect((await getTab(org, tab.id)).status).toBe('closed');
    const sales = (await report(org)).body;
    expect(sales.sales.byProduct).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Korting', revenueCents: -100 }), expect.objectContaining({ name: 'Pils', revenueCents: 600 })]));
    expect(sales.sales.revenueCents).toBe(500);
  });

  it('below zero: nothing to pay and not cancellable — until the discount is voided; at zero: cancellable', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Fout', lines: [line('korting', 'Korting', -100, 1)] });
    expect(tab.totalCents).toBe(-100);
    expect((await chargeCash(org, tab.id, 100)).body.code).toBe('tab_nothing_to_pay');
    const cancel = () => api('POST', tabsPath(org.orgId, `/${tab.id}/cancel`), { user: org.cashier, body: { reason: 'fout' } });
    expect((await cancel()).body.code).toBe('tab_not_empty');
    const lineId = tab.lines[0].id;
    const voided = await api('POST', tabsPath(org.orgId, `/${tab.id}/lines/${lineId}/void`), { user: org.cashier, body: { ...DEVICE, reason: 'fout', quantity: 1 } });
    expect(voided.body.totalCents).toBe(0);
    expect((await cancel()).status).toBe(200);
  });
});
