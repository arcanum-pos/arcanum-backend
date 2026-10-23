// A login provider with restricted clients (arcanum-auth): this
// installation assigns whoever it invites or imports, unassigns an address
// with no membership left, and now and then assigns every member again
// (organizations/client-access.ts). Only with the client's id and secret
// and a provider that advertises client_users_endpoint; best effort.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClientAccessCache } from '../src/organizations/client-access';
import { apiWith, seedOrg } from './helpers';

const ISSUER = 'https://issuer.test/';
const ENDPOINT = 'https://issuer.test/clients/self/users';
const CLIENT = { DEFAULT_IDP_CLIENT_ID: 'arc_client', DEFAULT_IDP_CLIENT_SECRET: 's3cret' };

let calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
let advertise = true;
let failing = false;

beforeEach(() => {
  calls = [];
  advertise = true;
  failing = false;
  resetClientAccessCache();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === `${ISSUER}.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, ...(advertise ? { client_users_endpoint: ENDPOINT } : {}) });
    }
    if (url.href.startsWith(ENDPOINT)) {
      calls.push({ method: request.method, url: url.href, auth: request.headers.get('Authorization'), body: request.method === 'POST' ? await request.json() : null });
      return failing ? new Response('nope', { status: 500 }) : Response.json({ ok: true });
    }
    throw new Error(`Unexpected outbound fetch in test: ${request.url}`);
  });
});
afterEach(() => vi.restoreAllMocks());

const invite = (org: Awaited<ReturnType<typeof seedOrg>>, email: string, env: Record<string, string> = CLIENT) =>
  apiWith(env, 'POST', `/organizations/${org.orgId}/members`, { user: org.admin, body: { email, role: 'cashier' } });

describe('client access at the login provider', () => {
  it('an invite assigns the address (with the client credentials); removing the last membership unassigns it', async () => {
    const org = await seedOrg();
    const email = `new-${crypto.randomUUID()}@test`;
    const invited = await invite(org, email.toUpperCase());
    expect(invited.status).toBe(201);
    expect(calls).toEqual([{ method: 'PUT', url: `${ENDPOINT}/${encodeURIComponent(email)}`, auth: `Basic ${btoa('arc_client:s3cret')}`, body: null }]);

    // Also invited in a second org: removing one membership keeps the assignment.
    const other = await seedOrg();
    await invite(other, email);
    calls = [];
    await apiWith(CLIENT, 'DELETE', `/organizations/${org.orgId}/members/${invited.body.id}`, { user: org.admin });
    expect(calls).toEqual([]);

    const second = (await apiWith(CLIENT, 'GET', `/organizations/${other.orgId}/members`, { user: other.admin })).body.find((m: { invitedEmail: string }) => m.invitedEmail === email);
    await apiWith(CLIENT, 'DELETE', `/organizations/${other.orgId}/members/${second.id}`, { user: other.admin });
    expect(calls).toEqual([{ method: 'DELETE', url: `${ENDPOINT}/${encodeURIComponent(email)}`, auth: `Basic ${btoa('arc_client:s3cret')}`, body: null }]);
  });

  it('nothing is told without the client credentials or when the provider does not advertise it; a failure never fails the invite', async () => {
    const org = await seedOrg();
    expect((await invite(org, `a-${crypto.randomUUID()}@test`, {})).status).toBe(201);
    advertise = false;
    expect((await invite(org, `b-${crypto.randomUUID()}@test`)).status).toBe(201);
    expect(calls).toEqual([]);

    resetClientAccessCache();
    advertise = true;
    failing = true;
    const res = await invite(org, `c-${crypto.randomUUID()}@test`);
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
  });

  it('an import assigns its members; aborting it unassigns who came only with it, never the importer', async () => {
    const source = await seedOrg();
    const file = (await apiWith(CLIENT, 'GET', `/organizations/${source.orgId}/export`, { user: source.admin })).body;
    const sub = `importer-${crypto.randomUUID()}`;
    const importer = { sub, issuer: ISSUER, name: 'Importeur', email: `${sub}@test` };
    const only = [`only-${crypto.randomUUID()}@test`, `only-${crypto.randomUUID()}@test`];
    const members = [...file.tables.memberships.slice(0, 2).map((m: Record<string, unknown>, i: number) => ({ ...m, invited_email: only[i] })), { ...file.tables.memberships[0], invited_email: importer.email }];
    const manifest = { format: file.format, version: file.version, organization: file.organization, counts: { ...Object.fromEntries(Object.entries(file.tables).map(([k, v]) => [k, (v as unknown[]).length])), memberships: members.length } };
    const start = await apiWith(CLIENT, 'POST', '/organizations/import/start', { user: importer, body: { manifest } });
    expect(start.status).toBe(201);
    calls = [];
    await apiWith(CLIENT, 'POST', `/organizations/${start.body.orgId}/import/chunk`, { user: importer, body: { table: 'memberships', rows: members } });
    expect(calls).toEqual([expect.objectContaining({ method: 'POST', body: { emails: [...only, importer.email] } })]);

    calls = [];
    expect((await apiWith(CLIENT, 'POST', `/organizations/${start.body.orgId}/import/abort`, { user: importer })).status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.url}`).sort()).toEqual(only.map((e) => `DELETE ${ENDPOINT}/${encodeURIComponent(e)}`).sort());
  });

  it('the console landing list assigns every member again, at most every few hours', async () => {
    const org = await seedOrg();
    await apiWith(CLIENT, 'GET', '/organizations', { user: org.admin });
    const bulk = calls.filter((c) => c.method === 'POST');
    expect(bulk.length).toBeGreaterThan(0);
    const sent = bulk.flatMap((c) => (c.body as { emails: string[] }).emails);
    expect(sent).toEqual(expect.arrayContaining([org.admin.email.toLowerCase(), org.cashier.email.toLowerCase()]));
    expect(bulk.every((c) => (c.body as { emails: string[] }).emails.length <= 500)).toBe(true);

    calls = [];
    await apiWith(CLIENT, 'GET', '/organizations', { user: org.admin });
    expect(calls).toEqual([]);
  });
});
