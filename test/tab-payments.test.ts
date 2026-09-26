// Paying tabs through cash/SumUp charges (/sumup/charge + /sumup/confirm):
// amount checks, one payment in flight per tab, closing + gapless receipt
// numbers, and what lands in the transactions ledger. Bancontact has its
// own file (bancontact.test.ts).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { settleTab } from '../src/tabs';
import { api, chargeCash, confirmCharge, createTab, getTab, line, orderBody, payCash, recordedCalls, rows, seedOrg, tabsPath, type TestOrg } from './helpers';

async function openTab(org: TestOrg, lines = [line('bon', 'Bonnen', 100, 10), line('pils', 'Pils', 150, 1)]) {
  return createTab(org, { label: 'Toog', lines });
}

describe('tab payments: charge rules', () => {
  it('refuses a charge for more than outstanding, or for nothing (409)', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    expect((await chargeCash(org, tab.id, 1151)).status).toBe(409);
    expect((await chargeCash(org, tab.id, 0)).status).not.toBe(201);
  });

  it("refuses a charge for another org's tab", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const foreign = await openTab(other);
    const res = await chargeCash(org, foreign.id, 1150);
    expect(res.status).toBe(404);
  });

  it('lets exactly one of several concurrent charges on one tab through', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    const results = await Promise.all(Array.from({ length: 5 }, () => chargeCash(org, tab.id, 1150)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
  });

  it('marks the tab as payment pending and refuses new orders meanwhile', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    expect((await chargeCash(org, tab.id, 1150)).status).toBe(201);
    expect((await getTab(org, tab.id)).paymentPending).toBe(true);

    const res = await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), { user: org.cashier, body: await orderBody(org, { lines: [line('x', 'x', 100, 1)] }) });
    expect(res.status).toBe(409);
  });

  it('keeps the tab open and payable again after a failed payment', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    const first = await chargeCash(org, tab.id, 1150);
    await confirmCharge(org, first.body.chargeId, false);

    const after = await getTab(org, tab.id);
    expect(after.status).toBe('open');
    expect(after.paymentPending).toBe(false);
    expect((await chargeCash(org, tab.id, 1150)).status).toBe(201);
  });

  it('refuses a charge on a closed tab (409)', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    await payCash(org, tab.id, 1150);
    expect((await chargeCash(org, tab.id, 1)).status).toBe(409);
  });
});

describe('tab payments: closing and receipt numbers', () => {
  it('closes a fully paid tab with receipt number 1', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    await payCash(org, tab.id, 1150);

    const closed = await getTab(org, tab.id);
    expect(closed.status).toBe('closed');
    expect(closed.receiptNumber).toBe(1);
    expect(closed.paidCents).toBe(1150);
    expect(closed.outstandingCents).toBe(0);
  });

  it('keeps receipt numbers gapless across a cancelled tab and a failed payment', async () => {
    const org = await seedOrg();
    const first = await openTab(org);
    await payCash(org, first.id, 1150);

    const empty = await createTab(org);
    await api('POST', tabsPath(org.orgId, `/${empty.id}/cancel`), { user: org.cashier, body: {} });

    const second = await openTab(org, [line('bon', 'Bonnen', 100, 5)]);
    const failed = await chargeCash(org, second.id, 500);
    await confirmCharge(org, failed.body.chargeId, false);
    await payCash(org, second.id, 500);

    expect((await getTab(org, second.id)).receiptNumber).toBe(2);
  });

  it('is idempotent when the same charge is confirmed twice', async () => {
    const org = await seedOrg();
    const tab = await openTab(org, [line('bon', 'Bonnen', 100, 5)]);
    const chargeId = await payCash(org, tab.id, 500);
    await confirmCharge(org, chargeId, true);

    const after = await getTab(org, tab.id);
    expect(after.receiptNumber).toBe(1);
    expect(after.paidCents).toBe(500);
    expect(await rows('SELECT id FROM transactions WHERE tab_id = ?', tab.id)).toHaveLength(1);
  });

  // Not reachable through the API today (a charge must equal the whole
  // outstanding amount), but settleTab must never close a tab short — this
  // is the guard for when split payments arrive.
  it('never closes a tab that is only partly paid', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    const insertPaid = (amount: number) =>
      env.DB.prepare(
        `INSERT INTO charges (id, org_id, method, status, amount_cents, created_at, tab_id) VALUES (?, ?, 'cash', 'succeeded', ?, ?, ?)`
      )
        .bind(crypto.randomUUID().replace(/-/g, ''), org.orgId, amount, new Date().toISOString(), tab.id)
        .run();

    await insertPaid(500);
    await settleTab(env, tab.id);
    expect((await getTab(org, tab.id)).status).toBe('open');

    await insertPaid(650);
    await settleTab(env, tab.id);
    const closed = await getTab(org, tab.id);
    expect(closed.status).toBe('closed');
    expect(closed.receiptNumber).toBe(1);
  });

  it('numbers receipts per org', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await payCash(a, (await openTab(a)).id, 1150);
    const tabB = await openTab(b);
    await payCash(b, tabB.id, 1150);
    expect((await getTab(b, tabB.id)).receiptNumber).toBe(1);
  });
});

describe('tab payments: transactions ledger', () => {
  it('records the legacy items JSON derived from net lines: counts per code, voided lines left out', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, {
      label: 'Toog',
      lines: [line('bon', 'Bonnen', 100, 10), line('pils', 'Pils', 150, 1), line('fietstocht', 'Fietstocht', 800, 2)],
    });
    const fiets = tab.lines.find((l: any) => l.itemCode === 'fietstocht');
    await api('POST', tabsPath(org.orgId, `/${tab.id}/lines/${fiets.id}/void`), { user: org.cashier, body: { reason: 'weg' } });

    await payCash(org, tab.id, 1150);

    const [tx] = await rows<{ amount_cents: number; items: string; tab_id: string; description: string; user_name: string }>(
      'SELECT amount_cents, items, tab_id, description, user_name FROM transactions WHERE tab_id = ?',
      tab.id
    );
    expect(tx.amount_cents).toBe(1150);
    expect(JSON.parse(tx.items)).toEqual({ bon: 10, pils: 1 });
    expect(tx.description).toBe(`Rekening #${tab.number} Toog`);
    expect(tx.user_name).toBe(org.cashier.name);
  });

  it('ignores a tabId sent directly to POST /transactions (only a charge may settle a tab)', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    const res = await api('POST', '/transactions', {
      user: org.cashier,
      body: { amountCents: 1150, method: 'cash', orgId: org.orgId, tabId: tab.id },
    });
    expect(res.status).toBe(201);
    expect(await rows('SELECT id FROM transactions WHERE tab_id = ?', tab.id)).toHaveLength(0);
    expect((await getTab(org, tab.id)).status).toBe('open');
  });
});

describe('charges without a tab (pre-tab kassa path)', () => {
  it('still records a plain cash sale with the client-supplied items', async () => {
    const org = await seedOrg();
    const res = await api('POST', '/sumup/charge', {
      user: org.cashier,
      body: { orgId: org.orgId, method: 'cash', amount: 300, description: '3 bonnen', items: { bon: 3 } },
    });
    expect(res.status).toBe(201);
    await confirmCharge(org, res.body.chargeId, true);

    const [tx] = await rows<{ items: string; tab_id: string | null; description: string }>(
      'SELECT items, tab_id, description FROM transactions WHERE org_id = ?',
      org.orgId
    );
    expect(JSON.parse(tx.items)).toEqual({ bon: 3 });
    expect(tx.tab_id).toBeNull();
    expect(tx.description).toBe('3 bonnen');
  });
});

describe('device notifications', () => {
  it('pushes payment_updated to the POS via devicehub when a charge is created and resolved', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    const posTerminalId = `pos-${crypto.randomUUID()}`;
    const res = await chargeCash(org, tab.id, 1150, { posTerminalId });
    await confirmCharge(org, res.body.chargeId, true);

    const pushes = (await recordedCalls('devicehub')).filter((c) => c.body?.pos_terminal_id === posTerminalId);
    expect(pushes.map((c) => c.path)).toEqual(['/devices/broadcast', '/devices/broadcast']);
    expect(pushes.every((c) => c.body.event === 'payment_updated' && c.body.payload.payment_id === res.body.chargeId)).toBe(true);
  });
});
