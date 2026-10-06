// Pairing and unpairing SumUp readers from the console (Toestellen): an admin
// of the org only, with the org's own SumUp account, SumUp stubbed (vi.spyOn
// on the global fetch — nothing reaches the network).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, seedOrg, type TestOrg } from './helpers';

let sumupRequests: { method: string; url: string; auth: string | null; body: any }[] = [];
let sumupReply: (method: string) => Response;

beforeEach(() => {
  sumupRequests = [];
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
      return sumupReply(request.method);
    }
    if (url.hostname.endsWith('.test') || url.hostname === 'localhost') return realFetch(input, init);
    throw new Error(`Unexpected outbound fetch in test: ${request.url}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function orgWithSumup(): Promise<TestOrg> {
  const org = await seedOrg();
  const res = await api('PUT', `/organizations/${org.orgId}/payment-credentials/sumup`, {
    user: org.admin,
    body: { merchantId: 'MSANDBOX1', apiKey: 'sup_sk_test' },
  });
  expect(res.status).toBe(200);
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

  it('a name is optional', async () => {
    const org = await orgWithSumup();
    expect((await pair(org, org.admin, { pairingCode: 'AB12CD345' })).status).toBe(201);
    expect(sumupRequests[0].body).toEqual({ pairing_code: 'AB12CD345', name: 'Solo' });
  });

  it("refuses a code that can't be one, without asking SumUp", async () => {
    const org = await orgWithSumup();
    for (const pairingCode of ['', 'ABC', 'AB12CD34567', 'AB12-CD34', 42]) {
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
