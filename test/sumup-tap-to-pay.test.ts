// Tap to Pay through the SumUp app (sumup.ts, release E): the affiliate key
// set in the console, a charge that hands the link's details to the waiter's
// page, and SumUp's own record of the transaction deciding — never the
// status the app sends back in the URL. SumUp stubbed (nothing reaches the
// network).
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createTab, DEVICE, getTab, line, rows, seedOrg, storePaymentConfig, type TestOrg } from './helpers';
import { sweepCharges } from '../src/payments/poller';

let transaction: (foreignId: string) => Response;
let sumupCalls: string[] = [];

beforeEach(() => {
  sumupCalls = [];
  transaction = () => Response.json({ detail: 'Not found' }, { status: 404 });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'api.sumup.com') {
      sumupCalls.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === '/v2.1/merchants/MSANDBOX1/transactions') return transaction(url.searchParams.get('foreign_transaction_id') ?? '');
      if (url.pathname.endsWith('/readers')) return Response.json({ items: [] });
      return Response.json({ merchant_code: 'MSANDBOX1' });
    }
    if (url.hostname.endsWith('.test') || url.hostname === 'localhost') return realFetch(input, init);
    throw new Error(`Unexpected outbound fetch in test: ${request.url}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function orgWithSumup(app = true): Promise<TestOrg> {
  const org = await seedOrg();
  await storePaymentConfig(org, 'sumup', { merchantId: 'MSANDBOX1', apiKey: 'sup_sk_test', confirmedAt: '2026-10-15T00:00:00Z', ...(app ? { affiliateKey: 'sup_afk_test123', appId: 'be.example.pos' } : {}) });
  return org;
}

async function appCharge(org: TestOrg) {
  const tab = await createTab(org, { lines: [line('COLA', 'Cola', 300, 2)] });
  const res = await api('POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, method: 'sumup', app: true, tabId: tab.id, amount: 600, ...DEVICE } });
  return { tab, res };
}

const ok = (amount = 6, status = 'SUCCESSFUL') => () => Response.json({ status, amount, currency: 'EUR', transaction_code: 'TEENSK4W2K' });

describe('setting up Tap to Pay (console)', () => {
  it('an admin adds the affiliate key to the saved SumUp account; the list says so, never the key', async () => {
    const org = await orgWithSumup(false);
    const put = (user: TestOrg['admin'], body: Record<string, unknown>) => api('PUT', `/organizations/${org.orgId}/payment-credentials/sumup/tap-to-pay`, { user, body });
    expect((await put(org.cashier, { affiliateKey: 'sup_afk_x12345678', appId: 'be.example.pos' })).status).toBe(403);
    expect((await put(org.admin, { affiliateKey: 'not a key!', appId: 'be.example.pos' })).body.code).toBe('sumup_affiliate_key_invalid');
    expect((await put(org.admin, { affiliateKey: 'sup_afk_x12345678', appId: 'be.example.pos' })).status).toBe(200);
    const list = await api('GET', `/organizations/${org.orgId}/payment-credentials`, { user: org.admin });
    const sumup = list.body.find((p: any) => p.provider === 'sumup');
    expect(sumup.tapToPay).toEqual({ appId: 'be.example.pos' });
    expect(JSON.stringify(list.body)).not.toContain('sup_afk_x12345678');
    const readers = await api('GET', `/sumup/readers?org_id=${org.orgId}`, { user: org.cashier });
    expect(readers.body.tapToPay).toBe(true);
    // Saving the SumUp key again keeps it.
    const save = (confirmMerchantId?: string) => api('PUT', `/organizations/${org.orgId}/payment-credentials/sumup`, { user: org.admin, body: { merchantId: 'MSANDBOX1', apiKey: 'sup_sk_test', confirmMerchantId } });
    await save();
    expect((await save('MSANDBOX1')).status).toBe(200);
    expect((await api('GET', `/sumup/readers?org_id=${org.orgId}`, { user: org.cashier })).body.tapToPay).toBe(true);
    // An empty key turns it off.
    expect((await put(org.admin, { affiliateKey: '' })).status).toBe(200);
    expect((await api('GET', `/sumup/readers?org_id=${org.orgId}`, { user: org.cashier })).body.tapToPay).toBe(false);
  });

  it('needs a SumUp account first', async () => {
    const org = await seedOrg();
    const res = await api('PUT', `/organizations/${org.orgId}/payment-credentials/sumup/tap-to-pay`, { user: org.admin, body: { affiliateKey: 'sup_afk_x12345678', appId: 'be.example.pos' } });
    expect(res.body.code).toBe('sumup_not_configured');
  });
});

describe('paying with Tap to Pay', () => {
  it('the charge gives the link its affiliate key; not set up: refused', async () => {
    const org = await orgWithSumup();
    const { res } = await appCharge(org);
    expect(res.status).toBe(201);
    expect(res.body.sumupApp).toEqual({ affiliateKey: 'sup_afk_test123', appId: 'be.example.pos' });
    const [charge] = await rows<{ provider_ref: string; expires_at: string }>('SELECT provider_ref, expires_at FROM charges WHERE id = ?', res.body.chargeId);
    expect(charge.provider_ref).toBe(res.body.chargeId);
    expect(Date.parse(charge.expires_at) - Date.now()).toBeGreaterThan(9 * 60 * 1000);

    const plain = await orgWithSumup(false);
    expect((await appCharge(plain)).res.body.code).toBe('sumup_app_not_configured');
  });

  it("back from the app: SumUp's transaction decides, the tab is paid", async () => {
    const org = await orgWithSumup();
    const { tab, res } = await appCharge(org);
    transaction = ok();
    const back = await api('POST', '/sumup/app-return', { user: org.cashier, body: { chargeId: res.body.chargeId, status: 'success' } });
    expect(back.body).toMatchObject({ status: 'succeeded', transactionCode: 'TEENSK4W2K' });
    expect(sumupCalls).toContain(`GET /v2.1/merchants/MSANDBOX1/transactions?foreign_transaction_id=${res.body.chargeId}`);
    expect((await getTab(org, tab.id)).status).toBe('closed');
  });

  it('a "success" in the URL with no transaction at SumUp stays pending', async () => {
    const org = await orgWithSumup();
    const { res } = await appCharge(org);
    const back = await api('POST', '/sumup/app-return', { user: org.cashier, body: { chargeId: res.body.chargeId, status: 'success' } });
    expect(back.body.status).toBe('pending');
  });

  it('a "failed" with no transaction: nothing was paid, the charge fails', async () => {
    const org = await orgWithSumup();
    const { tab, res } = await appCharge(org);
    const back = await api('POST', '/sumup/app-return', { user: org.cashier, body: { chargeId: res.body.chargeId, status: 'failed' } });
    expect(back.body.status).toBe('failed');
    expect((await getTab(org, tab.id)).status).toBe('open');
  });

  it('a different amount at SumUp is not taken as paid', async () => {
    const org = await orgWithSumup();
    const { res } = await appCharge(org);
    transaction = ok(0.6);
    const back = await api('POST', '/sumup/app-return', { user: org.cashier, body: { chargeId: res.body.chargeId, status: 'success' } });
    expect(back.body.status).toBe('failed');
    expect(back.body.errorMessage).toContain('klopt niet');
  });

  it('only a member of the org; only an app charge', async () => {
    const org = await orgWithSumup();
    const other = await seedOrg();
    const { res } = await appCharge(org);
    expect((await api('POST', '/sumup/app-return', { user: other.cashier, body: { chargeId: res.body.chargeId } })).status).toBe(403);
    const cash = await api('POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, method: 'cash', amount: 100, ...DEVICE } });
    expect((await api('POST', '/sumup/app-return', { user: org.cashier, body: { chargeId: cash.body.chargeId } })).status).toBe(404);
  });

  it('the poller finds it when the page never came back', async () => {
    const org = await orgWithSumup();
    const { tab, res } = await appCharge(org);
    transaction = ok();
    // Other tests' pending charges share the database: sweep on, as the poller does.
    const status = async () => (await rows<{ status: string }>('SELECT status FROM charges WHERE id = ?', res.body.chargeId))[0].status;
    let cursor = '';
    for (let i = 0; i < 50 && (await status()) === 'pending'; i++) cursor = (await sweepCharges(env as any, cursor)).cursor;
    expect(await status()).toBe('succeeded');
    expect((await getTab(org, tab.id)).status).toBe('closed');
  });
});
