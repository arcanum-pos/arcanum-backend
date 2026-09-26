// Bancontact tab payments with the provider stubbed (vi.spyOn on the global
// fetch — nothing reaches the network). Resolution goes through
// /sumup/confirm, the generic resolveCharge path: the real callback needs a
// genuine ES256 JWS from Bancontact, which isn't faked here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, confirmCharge, createTab, DEVICE, getTab, line, payCash, rows, seedOrg, type TestOrg } from './helpers';

const BANCONTACT_HOST = 'merchant.api.preprod.bancontact.net';

let bancontactRequests: { url: string; body: any }[] = [];
let bancontactReply: () => Response;

beforeEach(() => {
  bancontactRequests = [];
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
      },
      { status: 201 }
    );
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === BANCONTACT_HOST) {
      bancontactRequests.push({ url: request.url, body: await request.clone().json().catch(() => null) });
      return bancontactReply();
    }
    if (url.hostname.endsWith('.test') || url.hostname === 'localhost') return realFetch(input, init);
    throw new Error(`Unexpected outbound fetch in test: ${request.url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function orgWithBancontact(): Promise<TestOrg> {
  const org = await seedOrg();
  const res = await api('PUT', `/organizations/${org.orgId}/payment-credentials/bancontact`, {
    user: org.admin,
    body: { apiKey: 'test-api-key', environment: 'preprod' },
  });
  expect(res.status).toBe(200);
  return org;
}

function payBancontact(org: TestOrg, tabId: string, amount: number) {
  return api('POST', '/payments', { user: org.cashier, body: { orgId: org.orgId, tabId, amount, ...DEVICE } });
}

async function openTab(org: TestOrg) {
  return createTab(org, { label: 'Tafel 1', lines: [line('bon', 'Bonnen', 100, 10), line('pils', 'Pils', 150, 1)] });
}

describe('bancontact tab payments', () => {
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
