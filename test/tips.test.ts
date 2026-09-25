// Step 3d: fooi is a tip on the payment, not an order line. The customer
// pays outstanding + tip in one charge; the tip is recorded on the charge
// and the transaction but never counts toward the tab's paid amount.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, chargeCash, confirmCharge, createTab, DEVICE, getTab, line, rows, seedOrg, type TestOrg } from './helpers';

async function openTab(org: TestOrg) {
  return createTab(org, { label: 'Tafel 2', lines: [line('bon', 'Bonnen', 100, 10)] });
}

describe('tips on tab payments', () => {
  it('accepts amount = outstanding + tip and closes the tab with paid excluding the tip', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    const res = await chargeCash(org, tab.id, 1250, { tipCents: 250 });
    expect(res.status).toBe(201);
    await confirmCharge(org, res.body.chargeId);

    const closed = await getTab(org, tab.id);
    expect(closed.status).toBe('closed');
    expect([closed.totalCents, closed.paidCents, closed.outstandingCents]).toEqual([1000, 1000, 0]);
    expect(closed.payments[0]).toMatchObject({ amountCents: 1250, tipCents: 250 });
  });

  it('records the tip separately on the charge and in the transactions ledger', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    const res = await chargeCash(org, tab.id, 1250, { tipCents: 250 });
    await confirmCharge(org, res.body.chargeId);
    const [tx] = await rows<{ amount_cents: number; tip_cents: number }>('SELECT amount_cents, tip_cents FROM transactions WHERE tab_id = ?', tab.id);
    expect(tx).toEqual({ amount_cents: 1250, tip_cents: 250 });
    const status = await api('GET', `/sumup/status/${res.body.chargeId}`, { user: org.cashier });
    expect(status.body.tipCents).toBe(250);
  });

  it("refuses an amount that doesn't equal outstanding + tip (409)", async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    expect((await chargeCash(org, tab.id, 1000, { tipCents: 250 })).status).toBe(409);
    expect((await chargeCash(org, tab.id, 1250)).status).toBe(409);
  });

  it('refuses an invalid tip (400)', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    expect((await chargeCash(org, tab.id, 1000, { tipCents: -1 })).status).toBe(400);
    expect((await chargeCash(org, tab.id, 1000, { tipCents: 1.5 })).status).toBe(400);
    expect((await chargeCash(org, tab.id, 101_000, { tipCents: 100_001 })).status).toBe(400);
  });

  it('defaults the tip to 0', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    const res = await chargeCash(org, tab.id, 1000);
    const [charge] = await rows<{ tip_cents: number }>('SELECT tip_cents FROM charges WHERE id = ?', res.body.chargeId);
    expect(charge.tip_cents).toBe(0);
  });

  it('a failed payment with a tip leaves the tab fully outstanding', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    const res = await chargeCash(org, tab.id, 1250, { tipCents: 250 });
    await confirmCharge(org, res.body.chargeId, false);
    const after = await getTab(org, tab.id);
    expect([after.status, after.outstandingCents]).toEqual(['open', 1000]);
  });

  it("still derives items for an old open tab's legacy fooi line (cents)", async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    // A fooi line as the pre-3d kassa wrote it — no longer creatable via the API.
    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO orders (id, org_id, tab_id, source, submitted_at) VALUES (?, ?, ?, 'kassa', ?)`).bind(orderId, org.orgId, tab.id, now),
      env.DB.prepare(
        `INSERT INTO order_lines (id, org_id, tab_id, order_id, item_code, name, unit_price_cents, quantity, created_at) VALUES (?, ?, ?, ?, 'fooi', 'Fooi', 150, 1, ?)`
      ).bind(crypto.randomUUID(), org.orgId, tab.id, orderId, now),
    ]);
    const res = await chargeCash(org, tab.id, 1150);
    await confirmCharge(org, res.body.chargeId);
    const [tx] = await rows<{ items: string }>('SELECT items FROM transactions WHERE tab_id = ?', tab.id);
    expect(JSON.parse(tx.items)).toEqual({ bon: 10, fooi: 150 });
  });
});

describe('tips on a plain (non-tab) charge', () => {
  it('stores the tip too', async () => {
    const org = await seedOrg();
    const res = await api('POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, method: 'cash', amount: 500, tipCents: 100, ...DEVICE } });
    await confirmCharge(org, res.body.chargeId);
    const [tx] = await rows<{ tip_cents: number }>('SELECT tip_cents FROM transactions WHERE org_id = ?', org.orgId);
    expect(tx.tip_cents).toBe(100);
  });
});
