// Split payments (DOMAIN_MODEL.md "Split payments"): a tab is paid in parts
// — any amount up to what's open — and "Gelijk verdelen" keeps its plan on
// the tab so any kassa continues at the next part.
import { describe, expect, it } from 'vitest';
import { api, chargeCash, confirmCharge, createTab, DEVICE, getTab, line, orderBody, rows, seedOrg, tabsPath, type TestOrg } from './helpers';

const split = (org: TestOrg, tabId: string, parts: number | null) => api('POST', tabsPath(org.orgId, `/${tabId}/split`), { user: org.cashier, body: { parts } });

// A deliberate partial payment unless it's a split part.
async function pay(org: TestOrg, tabId: string, amount: number, extra: Record<string, unknown> = {}) {
  const res = await chargeCash(org, tabId, amount, extra.splitPart ? extra : { partial: true, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await confirmCharge(org, res.body.chargeId);
  return res.body.chargeId as string;
}

describe('partial payments', () => {
  it('pays a tab in parts; it closes (with its receipt number) only when fully paid', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 10), line('fietstocht', 'Fietstocht', 800, 2)] });
    await pay(org, tab.id, 1000);
    let now = await getTab(org, tab.id);
    expect([now.status, now.paidCents, now.outstandingCents, now.receiptNumber]).toEqual(['open', 1000, 1600, null]);

    await pay(org, tab.id, 1600);
    now = await getTab(org, tab.id);
    expect([now.status, now.paidCents, now.outstandingCents]).toEqual(['closed', 2600, 0]);
    expect(now.receiptNumber).toBe(1);
    expect(now.payments).toHaveLength(2);
  });

  it("records the legacy items JSON only on the payment that settles the tab (never twice)", async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 10)] });
    await pay(org, tab.id, 400);
    await pay(org, tab.id, 600);
    const txs = await rows<{ items: string; description: string; amount_cents: number }>('SELECT items, description, amount_cents FROM transactions WHERE tab_id = ? ORDER BY completed_at, rowid', tab.id);
    expect(txs.map((t) => [t.amount_cents, JSON.parse(t.items)])).toEqual([
      [400, {}],
      [600, { bon: 10 }],
    ]);
    expect(txs[0].description).toMatch(/\(deel\)$/);
  });

  it('a partial payment can carry its own tip', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 10)] });
    await pay(org, tab.id, 700, { tipCents: 200 }); // pays 500 of the tab
    expect((await getTab(org, tab.id)).outstandingCents).toBe(500);
  });

  it('no void below what is already paid (that would be a refund)', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 10), line('fietstocht', 'Fietstocht', 800, 2)] });
    await pay(org, tab.id, 2000);
    const byCode = (code: string) => tab.lines.find((l: any) => l.itemCode === code).id;
    const voidLine = (lineId: string, quantity: number) =>
      api('POST', tabsPath(org.orgId, `/${tab.id}/lines/${lineId}/void`), { user: org.cashier, body: { ...DEVICE, reason: 'fout', quantity } });

    const refused = await voidLine(byCode('fietstocht'), 1); // 2600 − 800 = 1800 < 2000 paid
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/al een deel betaald/);
    expect((await voidLine(byCode('bon'), 6)).status).toBe(201); // 2600 − 600 = 2000: still fine
    expect((await getTab(org, tab.id)).outstandingCents).toBe(0);
  });
});

describe('"Gelijk verdelen"', () => {
  it('splits what is open into equal parts; the last one takes the rounding', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 4', lines: [line('steak', 'Steak', 3400, 2), line('pintje', 'Pintje', 250, 3), line('water', 'Water', 200, 1)] }); // 7750
    const res = await split(org, tab.id, 3);
    expect(res.status).toBe(200);
    expect(res.body.split).toEqual({ parts: 3, paid: 0, nextCents: 2583 });

    await pay(org, tab.id, 2583, { splitPart: true });
    expect((await getTab(org, tab.id)).split).toEqual({ parts: 3, paid: 1, nextCents: 2583 });
    await pay(org, tab.id, 2583, { splitPart: true, method: 'sumup' });
    expect((await getTab(org, tab.id)).split).toEqual({ parts: 3, paid: 2, nextCents: 2584 });
    const last = await pay(org, tab.id, 2584, { splitPart: true });
    const parts = await rows<{ split_part: number }>('SELECT split_part FROM charges WHERE tab_id = ? ORDER BY created_at, rowid', tab.id);
    expect(parts.map((p) => p.split_part)).toEqual([1, 2, 3]);
    expect((await api('GET', `/sumup/status/${last}`, { user: org.cashier })).body.splitPart).toBe(3);
    const closed = await getTab(org, tab.id);
    expect([closed.status, closed.paidCents]).toEqual(['closed', 7750]);
  });

  it('is kept on the tab: another kassa (any GET) continues at the next part; a line added halfway spreads over what is left', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 2', lines: [line('bon', 'Bonnen', 100, 30)] }); // 3000
    await split(org, tab.id, 3);
    await pay(org, tab.id, 1000, { splitPart: true });
    await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), { user: org.cashier, body: await orderBody(org, { ...DEVICE, lines: [line('fietstocht', 'Fietstocht', 800, 1)] }) });
    const listed = (await api('GET', tabsPath(org.orgId), { user: org.cashier })).body.find((t: any) => t.id === tab.id);
    expect(listed.split).toEqual({ parts: 3, paid: 1, nextCents: 1400 }); // (2000 + 800) / 2
  });

  it('only a payment made as a part counts; a failed part does not', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 2', lines: [line('bon', 'Bonnen', 100, 30)] });
    await split(org, tab.id, 3);
    await pay(org, tab.id, 500); // a plain partial payment
    // splitPart without a plan (or when not asked) is just a partial payment.
    const failed = await chargeCash(org, tab.id, 833, { splitPart: true });
    await confirmCharge(org, failed.body.chargeId, false);
    expect((await getTab(org, tab.id)).split).toEqual({ parts: 3, paid: 0, nextCents: 833 }); // 2500 / 3
  });

  it('stops, restarts from what is open, and validates', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 2', lines: [line('bon', 'Bonnen', 100, 30)] });
    for (const parts of [1, 51, 2.5, 'drie']) expect((await split(org, tab.id, parts as number)).status, String(parts)).toBe(400);

    await split(org, tab.id, 3);
    await pay(org, tab.id, 1000, { splitPart: true });
    expect((await split(org, tab.id, 4)).body.split).toEqual({ parts: 4, paid: 0, nextCents: 500 }); // restarts on the 2000 open
    expect((await split(org, tab.id, null)).body.split).toBeNull();

    const pending = await chargeCash(org, tab.id, 2000);
    expect((await split(org, tab.id, 2)).status).toBe(409); // a payment is running
    await confirmCharge(org, pending.body.chargeId);
    expect((await split(org, tab.id, 2)).status).toBe(409); // closed
  });

  it('refuses more parts than cents open', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 2', lines: [line('bon', 'Bonnen', 100, 1)] });
    await pay(org, tab.id, 99);
    const res = await split(org, tab.id, 2);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Te weinig open/);
  });
});

describe('split part bookkeeping', () => {
  it('a split part without a plan (stopped on another kassa), or of a different amount, is refused (409)', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 2', lines: [line('bon', 'Bonnen', 100, 30)] });
    expect((await chargeCash(org, tab.id, 1000, { splitPart: true })).status).toBe(409);
    await split(org, tab.id, 3);
    expect((await chargeCash(org, tab.id, 999, { splitPart: true })).status).toBe(409);
    expect((await chargeCash(org, tab.id, 1000, { splitPart: true })).status).toBe(201);
  });

  it('without an intent it must still be exactly what is open — a stale kassa gets a 409, not a partial payment', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 2', lines: [line('bon', 'Bonnen', 100, 30)] });
    expect((await chargeCash(org, tab.id, 2000)).status).toBe(409);
    expect((await chargeCash(org, tab.id, 2000, { partial: true })).status).toBe(201);
  });

  it('the customer display sees the plan with the order', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 2', lines: [line('bon', 'Bonnen', 100, 30)] });
    await split(org, tab.id, 3);
    const charge = await chargeCash(org, tab.id, 1000, { splitPart: true });
    const status = await api('GET', `/sumup/status/${charge.body.chargeId}`, { user: org.cashier });
    expect([status.body.splitPart, status.body.order.split]).toEqual([1, { parts: 3, paid: 0 }]);
  });
});
