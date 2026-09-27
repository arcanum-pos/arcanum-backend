// Live tab sync between the kassas of one org: every change to a tab — or to
// a payment on it — pushes `tabs_changed { tab_id }` to all of the org's POS
// sockets via devicehub's /devices/broadcast-org. Plus the list endpoint's
// "today's bills" view (status=all + since) and the summary's methods/itemCount.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { expireStaleCharges } from '../src/payments/charges';
import { api, chargeCash, confirmCharge, createTab, DEVICE, getTab, identityHeaders, line, orderBody, recordedCalls, seedOrg, tabsPath, type TestOrg } from './helpers';

// The push is handed to waitUntil, so it can land just after the response.
async function tabPushes(org: TestOrg, atLeast = 1) {
  let pushes: { path: string; body: any }[] = [];
  for (let i = 0; i < 50; i++) {
    pushes = (await recordedCalls('devicehub')).filter((c) => c.path === '/devices/broadcast-org' && c.body?.org_id === org.orgId);
    if (pushes.length >= atLeast) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pushes;
}

// Waits for `count` more pushes than `before`, then checks nothing else trails in.
async function expectNewPushes(org: TestOrg, before: number, tabId: string, count = 1) {
  const pushes = await tabPushes(org, before + count);
  await new Promise((r) => setTimeout(r, 30));
  const all = await tabPushes(org, 0);
  expect(all.length - before, JSON.stringify(all.slice(before))).toBe(count);
  for (const p of pushes.slice(before)) expect(p.body).toEqual({ org_id: org.orgId, role: 'pos', event: 'tabs_changed', payload: { tab_id: tabId } });
}

async function countPushes(org: TestOrg) {
  await new Promise((r) => setTimeout(r, 30));
  return (await tabPushes(org, 0)).length;
}

describe('tabs_changed push', () => {
  it('on create, with and without lines (Toog)', async () => {
    const org = await seedOrg();
    const empty = await createTab(org, { label: 'Tafel 1' });
    await expectNewPushes(org, 0, empty.id);
    const toog = await createTab(org, { label: 'Toog', lines: [line('bon', 'Bonnen', 100, 2)] });
    await expectNewPushes(org, 1, toog.id);
  });

  it('on add order, void, rename, split set/clear and cancel', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1' });
    let n = await countPushes(org);
    const call = async (method: string, suffix: string, body: unknown) => {
      const res = await api(method, tabsPath(org.orgId, `/${tab.id}${suffix}`), { user: org.cashier, body });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      await expectNewPushes(org, n, tab.id);
      n++;
      return res.body;
    };

    const detail = await call('POST', '/orders', await orderBody(org, { ...DEVICE, lines: [line('pils', 'Pils', 250, 2)] }));
    await call('PATCH', '', { label: 'Tafel 1 — Jan' });
    await call('POST', '/split', { parts: 2 });
    await call('POST', '/split', { parts: null });
    await call('POST', `/lines/${detail.lines[0].id}/void`, { ...DEVICE, reason: 'fout' });
    await call('POST', '/cancel', { reason: 'leeg' });
  });

  it('not on a refused change', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 2)] });
    const n = await countPushes(org);
    expect((await api('POST', tabsPath(org.orgId, `/${tab.id}/cancel`), { user: org.cashier, body: {} })).status).toBe(409);
    expect((await api('PATCH', tabsPath(org.orgId, '/nope'), { user: org.cashier, body: { label: 'x' } })).status).toBe(404);
    expect(await countPushes(org)).toBe(n);
  });

  it('when a charge on the tab is created, succeeds or fails', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 4)] });
    let n = await countPushes(org);

    const failing = await chargeCash(org, tab.id, 400);
    expect(failing.status).toBe(201);
    await expectNewPushes(org, n++, tab.id);
    await confirmCharge(org, failing.body.chargeId, false);
    await expectNewPushes(org, n++, tab.id);

    const paying = await chargeCash(org, tab.id, 400);
    await expectNewPushes(org, n++, tab.id);
    await confirmCharge(org, paying.body.chargeId, true);
    await expectNewPushes(org, n++, tab.id);
    expect((await getTab(org, tab.id)).status).toBe('closed');

    // A second confirm changes nothing — and pushes nothing.
    await confirmCharge(org, paying.body.chargeId, true);
    expect(await countPushes(org)).toBe(n);
  });

  it('once when a SumUp reader dispatch fails right away (not configured)', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 4)] });
    const n = await countPushes(org);
    const res = await chargeCash(org, tab.id, 400, { method: 'sumup', readerId: 'rdr_1' });
    expect(res.status).toBe(201);
    await expectNewPushes(org, n, tab.id, 1);
    expect((await getTab(org, tab.id)).paymentPending).toBe(false);
  });

  it('when the poller expires a stale charge on the tab', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 4)] });
    const charge = await chargeCash(org, tab.id, 400);
    const n = await countPushes(org);
    await env.DB.prepare('UPDATE charges SET created_at = ? WHERE id = ?').bind(new Date(Date.now() - 60 * 60_000).toISOString(), charge.body.chargeId).run();

    await expireStaleCharges(env);
    await expectNewPushes(org, n, tab.id);
    expect((await getTab(org, tab.id)).paymentPending).toBe(false);
  });

  it('not for a charge without a tab', async () => {
    const org = await seedOrg();
    const res = await api('POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, method: 'cash', amount: 300, ...DEVICE } });
    await confirmCharge(org, res.body.chargeId, true);
    expect(await countPushes(org)).toBe(0);
  });
});

describe('a failing devicehub never fails a tab request', () => {
  afterEach(() => vi.restoreAllMocks());

  // The Worker called directly, with devicehub swapped for one that's down.
  async function callWith(devicehub: Fetcher, org: TestOrg, method: string, path: string, body?: unknown) {
    const res = await worker.fetch(
      new Request(`https://backend.test${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...identityHeaders(org.cashier) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      { ...env, ARCANUM_DEVICEHUB_SERVICE: devicehub }
    );
    return { status: res.status, body: (await res.json()) as any };
  }

  const down = { fetch: async () => { throw new Error('devicehub down'); } } as unknown as Fetcher;
  const erroring = { fetch: async () => new Response('boom', { status: 500 }) } as unknown as Fetcher;

  for (const [name, devicehub] of [['unreachable', down], ['answering 500', erroring]] as const) {
    it(`devicehub ${name}`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const org = await seedOrg();
      const created = await callWith(devicehub, org, 'POST', tabsPath(org.orgId), await orderBody(org, { label: 'Toog', ...DEVICE, lines: [line('bon', 'Bonnen', 100, 3)] }));
      expect(created.status).toBe(201);
      const renamed = await callWith(devicehub, org, 'PATCH', tabsPath(org.orgId, `/${created.body.id}`), { label: 'Tafel 9' });
      expect([renamed.status, renamed.body.label]).toEqual([200, 'Tafel 9']);
      const charge = await callWith(devicehub, org, 'POST', '/sumup/charge', { orgId: org.orgId, method: 'cash', tabId: created.body.id, amount: 300, ...DEVICE });
      expect(charge.status).toBe(201);
      const confirm = await callWith(devicehub, org, 'POST', '/sumup/confirm', { chargeId: charge.body.chargeId, success: true });
      expect(confirm.status).toBe(200);
      expect((await getTab(org, created.body.id)).status).toBe('closed');
    });
  }
});

describe('GET /tabs: status=all and since', () => {
  const DAY = 24 * 60 * 60_000;

  async function backdate(tabId: string, openedAt: number, closedAt: number | null = null) {
    await env.DB.prepare('UPDATE tabs SET opened_at = ?, closed_at = COALESCE(?, closed_at) WHERE id = ?')
      .bind(new Date(openedAt).toISOString(), closedAt === null ? null : new Date(closedAt).toISOString(), tabId)
      .run();
  }

  async function list(org: TestOrg, query: string) {
    return api('GET', tabsPath(org.orgId, query), { user: org.cashier });
  }

  it("today's bills: opened or closed since, plus anything still open; newest opened first", async () => {
    const org = await seedOrg();
    const now = Date.now();
    const since = new Date(now - 60 * 60_000).toISOString();

    const oldClosed = await createTab(org, { label: 'gisteren betaald', lines: [line('bon', 'Bonnen', 100, 1)] });
    await confirmCharge(org, (await chargeCash(org, oldClosed.id, 100)).body.chargeId);
    await backdate(oldClosed.id, now - DAY, now - DAY + 60_000);

    const closedToday = await createTab(org, { label: 'gisteren open, vandaag betaald', lines: [line('bon', 'Bonnen', 100, 1)] });
    await confirmCharge(org, (await chargeCash(org, closedToday.id, 100)).body.chargeId);
    await backdate(closedToday.id, now - DAY - 60_000);

    const stillOpen = await createTab(org, { label: 'gisteren open, nog open' });
    await backdate(stillOpen.id, now - 2 * DAY);

    const cancelledToday = await createTab(org, { label: 'vandaag geannuleerd' });
    expect((await api('POST', tabsPath(org.orgId, `/${cancelledToday.id}/cancel`), { user: org.cashier, body: {} })).status).toBe(200);

    const openToday = await createTab(org, { label: 'vandaag open' });

    const res = await list(org, `?status=all&since=${encodeURIComponent(since)}`);
    expect(res.status).toBe(200);
    expect(res.body.map((t: any) => t.label)).toEqual([openToday.label, cancelledToday.label, closedToday.label, stillOpen.label]);

    // since without status still means open only.
    expect((await list(org, `?since=${encodeURIComponent(since)}`)).body.map((t: any) => t.id)).toEqual([openToday.id, stillOpen.id]);
    // status=closed + since: only what closed (or opened) since.
    expect((await list(org, `?status=closed&since=${encodeURIComponent(since)}`)).body.map((t: any) => t.id)).toEqual([closedToday.id]);
    // status=all without since: everything, by number, newest first.
    expect((await list(org, '?status=all')).body.map((t: any) => t.number)).toEqual([5, 4, 3, 2, 1]);
    // No status: open only, as the kassa's tab strip expects.
    expect((await list(org, '')).body.map((t: any) => t.id)).toEqual([openToday.id, stillOpen.id]);
  });

  it('refuses an invalid since or status (400)', async () => {
    const org = await seedOrg();
    for (const q of ['?since=gisteren', '?since=', '?status=all&since=2026-13-45T00:00:00Z', '?status=paid']) {
      const res = await list(org, q);
      expect(res.status, q).toBe(400);
      expect(res.body.error).toBeTypeOf('string');
    }
  });
});

describe('tab summary: methods and itemCount', () => {
  it('methods: the distinct methods of succeeded payments, first paid first', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 10)] });
    expect(tab.methods).toEqual([]);

    const pay = async (amount: number, method: string, success = true) => {
      const res = await chargeCash(org, tab.id, amount, { method, partial: true });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await confirmCharge(org, res.body.chargeId, success);
    };
    await pay(300, 'bancontact', false); // failed: doesn't count
    await pay(300, 'sumup');
    await pay(300, 'cash');
    await pay(400, 'sumup');

    const detail = await getTab(org, tab.id);
    expect([detail.status, detail.methods]).toEqual(['closed', ['sumup', 'cash']]);
    const listed = (await api('GET', tabsPath(org.orgId, '?status=closed'), { user: org.cashier })).body;
    expect(listed.find((t: any) => t.id === tab.id).methods).toEqual(['sumup', 'cash']);
  });

  it('itemCount: units still on the tab, net of voids', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('pils', 'Pils', 250, 3), line('water', 'Water', 200, 2)] });
    expect(tab.itemCount).toBe(5);
    const pils = tab.lines.find((l: any) => l.itemCode === 'pils');
    const water = tab.lines.find((l: any) => l.itemCode === 'water');
    await api('POST', tabsPath(org.orgId, `/${tab.id}/lines/${pils.id}/void`), { user: org.cashier, body: { ...DEVICE, reason: 'fout', quantity: 1 } });
    await api('POST', tabsPath(org.orgId, `/${tab.id}/lines/${water.id}/void`), { user: org.cashier, body: { ...DEVICE, reason: 'fout' } });
    await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), { user: org.cashier, body: await orderBody(org, { ...DEVICE, lines: [line('pils', 'Pils', 250, 4)] }) });

    expect((await getTab(org, tab.id)).itemCount).toBe(6); // 3 − 1 + 4 pils, 2 − 2 water
    const [listed] = (await api('GET', tabsPath(org.orgId), { user: org.cashier })).body;
    expect(listed.itemCount).toBe(6);
  });

  it('itemCount leaves out legacy fooi lines', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { label: 'Tafel 1', lines: [line('pils', 'Pils', 250, 2)] });
    // A pre-3d fooi line: an amount, not units.
    await env.DB.prepare(
      `INSERT INTO order_lines (id, org_id, tab_id, order_id, item_code, name, unit_price_cents, quantity, created_at)
       VALUES (?, ?, ?, ?, 'fooi', 'Fooi', 1, 150, ?)`
    )
      .bind(crypto.randomUUID(), org.orgId, tab.id, tab.orders[0].id, new Date().toISOString())
      .run();
    expect((await getTab(org, tab.id)).itemCount).toBe(2);
  });
});
