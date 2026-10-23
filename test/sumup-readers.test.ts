// Pairing and unpairing SumUp readers from the console (Toestellen): an admin
// of the org only, with the org's own SumUp account, SumUp stubbed (vi.spyOn
// on the global fetch — nothing reaches the network).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, confirmCharge, createTab, DEVICE, getTab, line, seedOrg, type TestOrg } from './helpers';

let sumupRequests: { method: string; url: string; auth: string | null; body: any }[] = [];
let sumupReply: (method: string, path: string) => Response;
let accountReply: { readers: () => Response; profile: () => Response };

beforeEach(() => {
  sumupRequests = [];
  accountReply = {
    readers: () => Response.json({ items: [] }),
    profile: () => Response.json({ merchant_code: 'MSANDBOX1', business_profile: { name: 'Scouts Kabouterland' }, company: { name: 'Scouts Kabouterland vzw' } }),
  };
  sumupReply = (method) =>
    method === 'DELETE'
      ? new Response(null, { status: 204 })
      : Response.json({ id: 'rdr_1', name: 'Toog', status: 'processing', device: { identifier: 'v-1', model: 'virtual-solo' } }, { status: 201 });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'api.sumup.com') {
      sumupRequests.push({ method: request.method, url: request.url, auth: request.headers.get('Authorization'), body: await request.clone().json().catch(() => null) });
      // The account check when saving (checkSumupAccount): the readers, the merchant's profile.
      if (request.method === 'GET' && url.pathname.endsWith('/readers')) return accountReply.readers();
      if (request.method === 'GET' && url.pathname.startsWith('/v1/merchants/')) return accountReply.profile();
      return sumupReply(request.method, url.pathname);
    }
    if (url.hostname.endsWith('.test') || url.hostname === 'localhost') return realFetch(input, init);
    throw new Error(`Unexpected outbound fetch in test: ${request.url}`);
  });
});

afterEach(() => vi.restoreAllMocks());

// A merchant code and key saved through the console: the account shown, then confirmed.
async function orgWithSumup(): Promise<TestOrg> {
  const org = await seedOrg();
  const save = (confirmMerchantId?: string) =>
    api('PUT', `/organizations/${org.orgId}/payment-credentials/sumup`, { user: org.admin, body: { merchantId: 'MSANDBOX1', apiKey: 'sup_sk_test', confirmMerchantId } });
  expect((await save()).status).toBe(409);
  expect((await save('MSANDBOX1')).status).toBe(200);
  sumupRequests = [];
  return org;
}

const pair = (org: TestOrg, user: TestOrg['admin'] | null, body: Record<string, unknown>) =>
  api('POST', '/sumup/readers', { user, body: { orgId: org.orgId, ...body } });

describe('pairing a SumUp reader', () => {
  it("sends the code (as typed, without spaces) and a name to SumUp with the org's own key", async () => {
    const org = await orgWithSumup();
    const res = await pair(org, org.admin, { pairingCode: ' ab12 cd34 ', name: 'Toog' });
    expect(res.status).toBe(201);
    expect(res.body.reader).toEqual({ id: 'rdr_1', name: 'Toog', status: 'processing', model: 'virtual-solo' });
    expect(sumupRequests).toEqual([
      { method: 'POST', url: 'https://api.sumup.com/v0.1/merchants/MSANDBOX1/readers', auth: 'Bearer sup_sk_test', body: { pairing_code: 'AB12CD34', name: 'Toog' } },
    ]);
  });

  it("a virtual reader's code from SumUp's dashboard: dashes and other lengths are fine — SumUp decides", async () => {
    const org = await orgWithSumup();
    expect((await pair(org, org.admin, { pairingCode: 'ab12-cd34-ef', name: 'Virtueel' })).status).toBe(201);
    expect(sumupRequests[0].body).toEqual({ pairing_code: 'AB12CD34EF', name: 'Virtueel' });
  });

  it('a name is optional', async () => {
    const org = await orgWithSumup();
    expect((await pair(org, org.admin, { pairingCode: 'AB12CD345' })).status).toBe(201);
    expect(sumupRequests[0].body).toEqual({ pairing_code: 'AB12CD345', name: 'Solo' });
  });

  it("refuses a code that can't be one, without asking SumUp", async () => {
    const org = await orgWithSumup();
    for (const pairingCode of ['', 'ABC', 'AB12CD34567890XYZ', 'AB12/CD34', 42]) {
      const res = await pair(org, org.admin, { pairingCode });
      expect(res.status, String(pairingCode)).toBe(400);
      expect(res.body.code).toBe('sumup_pairing_code_invalid');
    }
    expect(sumupRequests).toHaveLength(0);
  });

  it("passes SumUp's own reason on when it refuses (e.g. an expired code)", async () => {
    const org = await orgWithSumup();
    sumupReply = () => Response.json({ type: 'NOT_FOUND', detail: 'Pairing code not found' }, { status: 404 });
    const res = await pair(org, org.admin, { pairingCode: 'AB12CD34' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'sumup_pair_failed', params: { detail: 'Pairing code not found' } });
  });

  it('without a SumUp account for the org: says so', async () => {
    const org = await seedOrg();
    const res = await pair(org, org.admin, { pairingCode: 'AB12CD34' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('sumup_not_configured');
    expect(sumupRequests).toHaveLength(0);
  });
});

describe('unpairing a SumUp reader', () => {
  it('removes it from the merchant account', async () => {
    const org = await orgWithSumup();
    const res = await api('DELETE', `/sumup/readers/rdr_1?org_id=${org.orgId}`, { user: org.admin });
    expect(res.status).toBe(200);
    expect(sumupRequests).toEqual([{ method: 'DELETE', url: 'https://api.sumup.com/v0.1/merchants/MSANDBOX1/readers/rdr_1', auth: 'Bearer sup_sk_test', body: null }]);
  });

  it("passes SumUp's reason on when it fails", async () => {
    const org = await orgWithSumup();
    sumupReply = () => Response.json({ type: 'NOT_FOUND', detail: 'Reader not found' }, { status: 404 });
    const res = await api('DELETE', `/sumup/readers/nope?org_id=${org.orgId}`, { user: org.admin });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'sumup_remove_failed', params: { detail: 'Reader not found' } });
  });
});

describe('only for an admin of the org', () => {
  it('refuses a signed-out caller, a cashier and an admin of another org — SumUp is never asked', async () => {
    const org = await orgWithSumup();
    const other = await seedOrg();
    for (const [user, status] of [[null, 401], [org.cashier, 403], [other.admin, 403]] as const) {
      expect((await pair(org, user, { pairingCode: 'AB12CD34' })).status).toBe(status);
      expect((await api('DELETE', `/sumup/readers/rdr_1?org_id=${org.orgId}`, { user })).status).toBe(status);
    }
    expect(sumupRequests).toHaveLength(0);
  });
});

describe('which SumUp account a merchant code and key are', () => {
  it("the key must work for the merchant code; the account's name shown to confirm — kept only once confirmed", async () => {
    const org = await seedOrg();
    const save = (body: Record<string, unknown>) => api('PUT', `/organizations/${org.orgId}/payment-credentials/sumup`, { user: org.admin, body: { merchantId: 'msandbox1', apiKey: 'sup_sk_test', ...body } });
    const first = await save({});
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ code: 'sumup_confirm_account', account: { merchantId: 'MSANDBOX1', name: 'Scouts Kabouterland', sandbox: null } });
    expect((await api('GET', `/organizations/${org.orgId}/payment-credentials`, { user: org.admin })).body).toEqual([]);
    expect((await save({ confirmMerchantId: 'MSANDBOX1' })).status).toBe(200);
    const listed = (await api('GET', `/organizations/${org.orgId}/payment-credentials`, { user: org.admin })).body;
    expect(listed).toEqual([expect.objectContaining({ provider: 'sumup', account: { merchantId: 'MSANDBOX1', name: 'Scouts Kabouterland', sandbox: null } })]);
    expect(JSON.stringify(listed)).not.toContain('sup_sk_test');
  });

  it("a key that doesn't work for the merchant code: refused; a profile it may not read: confirmed without a name", async () => {
    const org = await seedOrg();
    const save = (body: Record<string, unknown>) => api('PUT', `/organizations/${org.orgId}/payment-credentials/sumup`, { user: org.admin, body: { merchantId: 'MOTHER', apiKey: 'sup_sk_test', ...body } });
    accountReply.readers = () => Response.json({ detail: 'Forbidden', type: 'FORBIDDEN' }, { status: 403 });
    expect((await save({})).body).toMatchObject({ code: 'sumup_key_refused', detail: '403: Forbidden' });
    accountReply.readers = () => Response.json({ items: [] });
    accountReply.profile = () => Response.json({ detail: 'insufficient scope' }, { status: 403 });
    expect((await save({})).body).toMatchObject({ code: 'sumup_confirm_account', account: { merchantId: 'MOTHER', name: null, sandbox: null } });
  });

  it("a sandbox merchant: SumUp's profile says so, kept with the account and listed", async () => {
    const org = await seedOrg();
    accountReply.profile = () => Response.json({ merchant_code: 'MSANDBOX1', business_profile: { name: 'Kabouterland Sandbox' }, sandbox: true });
    const save = (body: Record<string, unknown>) => api('PUT', `/organizations/${org.orgId}/payment-credentials/sumup`, { user: org.admin, body: { merchantId: 'MSANDBOX1', apiKey: 'sup_sk_test', ...body } });
    expect((await save({})).body).toMatchObject({ account: { merchantId: 'MSANDBOX1', name: 'Kabouterland Sandbox', sandbox: true } });
    expect((await save({ confirmMerchantId: 'MSANDBOX1' })).status).toBe(200);
    const listed = (await api('GET', `/organizations/${org.orgId}/payment-credentials`, { user: org.admin })).body;
    expect(listed).toEqual([expect.objectContaining({ account: { merchantId: 'MSANDBOX1', name: 'Kabouterland Sandbox', sandbox: true } })]);
    accountReply.profile = () => Response.json({ merchant_code: 'MREAL', business_profile: { name: 'Echt' }, sandbox: false });
    expect((await api('PUT', `/organizations/${org.orgId}/payment-credentials/sumup`, { user: org.admin, body: { merchantId: 'MREAL', apiKey: 'k' } })).body).toMatchObject({ account: { sandbox: false } });
  });
});

describe('a payment on a reader, cancelled at the kassa', () => {
  // The reader checkout, its terminate and its status (as `ended`).
  function readerAnswers(ended: string) {
    sumupReply = (_method, path) =>
      path.endsWith('/checkout') ? Response.json({ data: { checkout_id: 'co_1', client_transaction_id: 'tx_1' } }, { status: 201 })
      : path.endsWith('/checkout/co_1') ? Response.json({ data: { status: ended, payment_failure_reason: null } })
      : new Response(null, { status: 204 })
  }
  async function onReader(org: TestOrg) {
    const tab = await createTab(org, { label: 'Tafel 2', lines: [line('pils', 'Pils', 250, 2)] })
    const res = await api('POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, tabId: tab.id, amount: 500, readerId: 'rdr_1', ...DEVICE } })
    expect(res.status).toBe(201)
    return { tab, chargeId: res.body.chargeId as string }
  }

  it('stops it on the reader, then the tab is free again', async () => {
    const org = await orgWithSumup()
    readerAnswers('cancelled')
    const { tab, chargeId } = await onReader(org)
    expect((await confirmCharge(org, chargeId, false)).body).toMatchObject({ ok: true, status: 'failed' })
    expect(sumupRequests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'POST /v0.1/merchants/MSANDBOX1/readers/rdr_1/checkout',
      'POST /v0.1/merchants/MSANDBOX1/readers/rdr_1/terminate',
      'GET /v0.1/merchants/MSANDBOX1/readers/rdr_1/checkout/co_1',
    ])
    expect((await getTab(org, tab.id)).paymentPending).toBe(false)
  })

  it('the card was just tapped: it stays paid', async () => {
    const org = await orgWithSumup()
    readerAnswers('successful')
    const { tab, chargeId } = await onReader(org)
    expect((await confirmCharge(org, chargeId, false)).body).toMatchObject({ status: 'succeeded' })
    expect((await getTab(org, tab.id)).status).toBe('closed')
  })
})
