// Bancontact tab payments with the provider stubbed (vi.spyOn on the global
// fetch — nothing reaches the network). Resolution goes through
// /sumup/confirm, the generic resolveCharge path: the real callback needs a
// genuine ES256 JWS from Bancontact, which isn't faked here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, confirmCharge, createTab, DEVICE, getTab, line, payCash, recordedCalls, rows, seedOrg, type TestOrg } from './helpers';

const BANCONTACT_HOST = 'merchant.api.preprod.bancontact.net';

let bancontactRequests: { url: string; method: string; body: any }[] = [];
let bancontactReply: (request: Request) => Response;
// Whose account Bancontact's answers name.
let creditorId = 'm-1';

beforeEach(() => {
  bancontactRequests = [];
  creditorId = 'm-1';
  bancontactReply = () =>
    Response.json(
      {
        paymentId: 'bc-payment-1',
        status: 'PENDING',
        amount: 1150,
        currency: 'EUR',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        _links: { qrcode: { href: 'https://qr.test/1.png' }, deeplink: { href: 'bancontact://pay/1' } },
        // The account the key pays out to (what bancontact-account.ts checks).
        creditor: { merchantId: creditorId, name: 'Scouts Kabouterland', iban: 'BE68539007547034' },
      },
      { status: 201 }
    );
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === BANCONTACT_HOST) {
      bancontactRequests.push({ url: request.url, method: request.method, body: await request.clone().json().catch(() => null) });
      return bancontactReply(request);
    }
    if (url.hostname.endsWith('.test') || url.hostname === 'localhost') return realFetch(input, init);
    throw new Error(`Unexpected outbound fetch in test: ${request.url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A key saved through the console: its account shown, then confirmed.
async function orgWithBancontact(): Promise<TestOrg> {
  const org = await seedOrg();
  const save = (confirmMerchantId?: string) =>
    api('PUT', `/organizations/${org.orgId}/payment-credentials/bancontact`, { user: org.admin, body: { apiKey: 'test-api-key', environment: 'preprod', confirmMerchantId } });
  expect((await save()).status).toBe(409);
  expect((await save('m-1')).status).toBe(200);
  bancontactRequests = [];
  return org;
}

function payBancontact(org: TestOrg, tabId: string, amount: number) {
  return api('POST', '/payments', { user: org.cashier, body: { orgId: org.orgId, tabId, amount, ...DEVICE } });
}

async function openTab(org: TestOrg) {
  return createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 10), line('pils', 'Pils', 150, 1)] });
}

describe('bancontact tab payments', () => {
  it("tells the org's kassas the tab has a payment pending (tabs_changed)", async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    const res = await payBancontact(org, tab.id, 1150);
    expect(res.status).toBe(201);
    let pushes: { body: any }[] = [];
    // Handed to waitUntil: may land just after the response.
    for (let i = 0; i < 50 && pushes.length < 2; i++) {
      pushes = (await recordedCalls('devicehub')).filter((c) => c.path === '/devices/tabs-changed' && c.body?.org_id === org.orgId);
      if (pushes.length < 2) await new Promise((r) => setTimeout(r, 10));
    }
    // One for opening the tab, one for the payment.
    expect(pushes.map((p) => p.body.tab_ids)).toEqual([[tab.id], [tab.id]]);
  });

  it('charges outstanding + tip at Bancontact and stores the tip on the charge', async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    const res = await api('POST', '/payments', { user: org.cashier, body: { orgId: org.orgId, tabId: tab.id, amount: 1350, tipCents: 200, ...DEVICE } });
    expect(res.status).toBe(201);
    expect(bancontactRequests[0].body).toMatchObject({ amount: 1350 });
    const [charge] = await rows<{ tip_cents: number; amount_cents: number }>('SELECT tip_cents, amount_cents FROM charges WHERE id = ?', res.body.chargeId);
    expect(charge).toEqual({ tip_cents: 200, amount_cents: 1350 });
  });

  it('refuses paying more than what is open (tip aside) before calling Bancontact (409)', async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    const res = await api('POST', '/payments', { user: org.cashier, body: { orgId: org.orgId, tabId: tab.id, amount: 1400, tipCents: 200, ...DEVICE } });
    expect(res.status).toBe(409);
    expect(bancontactRequests).toHaveLength(0);
  });

  it('refuses a wrong amount before calling Bancontact at all', async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    expect((await payBancontact(org, tab.id, 1151)).status).toBe(409); // more than open
    expect((await api('POST', '/payments', { user: org.cashier, body: { orgId: org.orgId, tabId: tab.id, amount: 200, tipCents: 200, ...DEVICE } })).status).toBe(409); // only a tip
    expect(bancontactRequests).toHaveLength(0);
  });

  it('refuses a closed tab before calling Bancontact at all', async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    await payCash(org, tab.id, 1150);
    const res = await payBancontact(org, tab.id, 1150);
    expect(res.status).toBe(409);
    expect(bancontactRequests).toHaveLength(0);
  });

  it('creates a Bancontact payment and a pending charge tied to the tab', async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    const res = await payBancontact(org, tab.id, 1150);

    expect(res.status).toBe(201);
    expect(res.body.qrCodeUrl).toBe('https://qr.test/1.png');
    expect(bancontactRequests).toHaveLength(1);
    // Our charge id doubles as Bancontact's `reference` — hard 35-char limit.
    expect(bancontactRequests[0].body).toMatchObject({ amount: 1150, currency: 'EUR', reference: res.body.chargeId });
    expect(res.body.chargeId).toMatch(/^[0-9a-f]{32}$/);

    const [charge] = await rows<{ tab_id: string; status: string; method: string; provider_ref: string; items: string }>(
      'SELECT tab_id, status, method, provider_ref, items FROM charges WHERE id = ?',
      res.body.chargeId
    );
    expect(charge).toMatchObject({ tab_id: tab.id, status: 'pending', method: 'bancontact', provider_ref: 'bc-payment-1' });
    expect(JSON.parse(charge.items)).toEqual({ bon: 10, pils: 1 });
    expect((await getTab(org, tab.id)).paymentPending).toBe(true);
  });

  it('closes the tab once the Bancontact charge resolves successfully', async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    const res = await payBancontact(org, tab.id, 1150);
    await confirmCharge(org, res.body.chargeId, true);

    const closed = await getTab(org, tab.id);
    expect(closed.status).toBe('closed');
    expect(closed.receiptNumber).toBe(1);
    const [tx] = await rows<{ method: string; tab_id: string }>('SELECT method, tab_id FROM transactions WHERE tab_id = ?', tab.id);
    expect(tx).toEqual({ method: 'bancontact', tab_id: tab.id });
  });

  it('leaves no charge behind when Bancontact rejects the payment, so the tab stays payable', async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    bancontactReply = () => Response.json({ error: 'nope' }, { status: 400 });

    const res = await payBancontact(org, tab.id, 1150);
    expect(res.status).toBe(400);
    expect(await rows('SELECT id FROM charges WHERE tab_id = ?', tab.id)).toHaveLength(0);
    expect((await getTab(org, tab.id)).paymentPending).toBe(false);
  });

  it('reports a missing Bancontact configuration without a provider call', async () => {
    const org = await seedOrg();
    const tab = await openTab(org);
    const res = await payBancontact(org, tab.id, 1150);
    expect(res.status).toBe(400);
    expect(bancontactRequests).toHaveLength(0);
  });
});

describe('which account a Bancontact key pays out to', () => {
  it('saving a key: a test payment of a cent, cancelled, its account shown to confirm - kept only once confirmed', async () => {
    const org = await seedOrg();
    const save = (body: Record<string, unknown>) => api('PUT', `/organizations/${org.orgId}/payment-credentials/bancontact`, { user: org.admin, body: { apiKey: 'test-api-key', environment: 'preprod', ...body } });
    const first = await save({});
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ code: 'bancontact_confirm_account', account: { merchantId: 'm-1', name: 'Scouts Kabouterland', iban: 'BE•• •••• •••• 7034' } });
    // A cent, then cancelled; nothing kept yet.
    expect(bancontactRequests.map((r) => [new URL(r.url).pathname, r.body?.amount ?? null])).toEqual([['/v3/payments', 1], ['/v3/payments/bc-payment-1', null]]);
    expect((await api('GET', `/organizations/${org.orgId}/payment-credentials`, { user: org.admin })).body).toEqual([]);
    // Confirming another account than the key's: not kept.
    expect((await save({ confirmMerchantId: 'm-2' })).status).toBe(409);
    expect((await save({ confirmMerchantId: 'm-1' })).status).toBe(200);
    const listed = (await api('GET', `/organizations/${org.orgId}/payment-credentials`, { user: org.admin })).body;
    expect(listed).toEqual([expect.objectContaining({ provider: 'bancontact', environment: 'preprod', account: { merchantId: 'm-1', name: 'Scouts Kabouterland', iban: 'BE•• •••• •••• 7034' } })]);
    expect(JSON.stringify(listed)).not.toContain('test-api-key');
  });

  it('a key Bancontact refuses: says so, nothing kept', async () => {
    const org = await seedOrg();
    bancontactReply = () => Response.json({ code: 'UNAUTHORIZED', message: 'Invalid API key' }, { status: 401 });
    const res = await api('PUT', `/organizations/${org.orgId}/payment-credentials/bancontact`, { user: org.admin, body: { apiKey: 'wrong', environment: 'preprod' } });
    expect(res.body).toMatchObject({ code: 'bancontact_key_refused', detail: '401 UNAUTHORIZED: Invalid API key' });
  });

  it('a payment that would go to another account than the confirmed one: cancelled and refused', async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    creditorId = 'm-other';
    const res = await payBancontact(org, tab.id, 1150);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('bancontact_wrong_account');
    expect(bancontactRequests.map((r) => [r.url.endsWith('/v3/payments') ? 'create' : 'cancel'])).toEqual([['create'], ['cancel']]);
    expect(await rows('SELECT id FROM charges WHERE tab_id = ?', tab.id)).toEqual([]);
  });
});

describe('cancelled at the kassa (Bancontact)', () => {
  // After the payment's creation: a DELETE (cancel) and a GET (its status) answered as `ended`.
  function endsAs(ended: string) {
    const created = bancontactReply;
    bancontactReply = (request) =>
      request.method === 'DELETE' ? new Response(null, { status: 204 }) : request.method === 'GET' ? Response.json({ paymentId: 'bc-payment-1', status: ended }) : created(request);
  }

  it('cancels it at Bancontact (its QR stops), then the tab is free again', async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    const res = await payBancontact(org, tab.id, 1150);
    endsAs('CANCELLED');
    const cancelled = await confirmCharge(org, res.body.chargeId, false);
    expect(cancelled.body).toMatchObject({ ok: true, status: 'failed' });
    expect(bancontactRequests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['POST /v3/payments', 'DELETE /v3/payments/bc-payment-1', 'GET /v3/payments/bc-payment-1']);
    expect((await getTab(org, tab.id)).paymentPending).toBe(false);
    expect((await getTab(org, tab.id)).status).toBe('open');
  });

  it('just paid after all: it stays paid - never failed on our side while Bancontact took it', async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    const res = await payBancontact(org, tab.id, 1150);
    endsAs('SUCCEEDED');
    expect((await confirmCharge(org, res.body.chargeId, false)).body).toMatchObject({ ok: true, status: 'succeeded' });
    expect((await getTab(org, tab.id)).status).toBe('closed');
  });

  it("Bancontact can't be reached: it stays pending (the customer could still pay) and the kassa is told to try again", async () => {
    const org = await orgWithBancontact();
    const tab = await openTab(org);
    const res = await payBancontact(org, tab.id, 1150);
    const created = bancontactReply;
    bancontactReply = (request) => (request.method === 'POST' ? created(request) : new Response('down', { status: 503 }));
    const refused = await confirmCharge(org, res.body.chargeId, false);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('payment_cancel_unconfirmed');
    expect((await getTab(org, tab.id)).paymentPending).toBe(true);
    // Reachable again: the next try cancels it.
    endsAs('CANCELLED');
    expect((await confirmCharge(org, res.body.chargeId, false)).body).toMatchObject({ status: 'failed' });
  });
});
