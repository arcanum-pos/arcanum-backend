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

const AUTH = `Basic ${btoa('arc_client:s3cret')}`;
// What the provider was told, per address: its role, or 'removed'.
const told = () =>
  Object.fromEntries(
    calls.flatMap((c) =>
      c.method === 'POST'
        ? (c.body as { users: { email: string; role: string }[] }).users.map((u) => [u.email, u.role])
        : c.method === 'DELETE'
          ? [[decodeURIComponent(c.url.slice(ENDPOINT.length + 1)), 'removed']]
          : []
    )
  );

describe('client access at the login provider', () => {
  it('an invite assigns the address (with the client credentials); removing the last membership unassigns it', async () => {
    const org = await seedOrg();
    const email = `new-${crypto.randomUUID()}@test`;
    const invited = await invite(org, email.toUpperCase());
    expect(invited.status).toBe(201);
    expect(calls).toEqual([{ method: 'POST', url: ENDPOINT, auth: AUTH, body: { users: [{ email, role: 'member' }] } }]);

    // Also invited in a second org: removing one membership keeps the assignment.
    const other = await seedOrg();
    await invite(other, email);
    calls = [];
    await apiWith(CLIENT, 'DELETE', `/organizations/${org.orgId}/members/${invited.body.id}`, { user: org.admin });
    expect(told()).toEqual({ [email]: 'member' });

    calls = [];
    const second = (await apiWith(CLIENT, 'GET', `/organizations/${other.orgId}/members`, { user: other.admin })).body.find((m: { invitedEmail: string }) => m.invitedEmail === email);
    await apiWith(CLIENT, 'DELETE', `/organizations/${other.orgId}/members/${second.id}`, { user: other.admin });
    expect(calls).toEqual([{ method: 'DELETE', url: `${ENDPOINT}/${encodeURIComponent(email)}`, auth: AUTH, body: null }]);
  });

  it('an admin of any organisation here is an admin of the client; demoted everywhere, a member again', async () => {
    const org = await seedOrg();
    const email = `boss-${crypto.randomUUID()}@test`;
    const invited = await apiWith(CLIENT, 'POST', `/organizations/${org.orgId}/members`, { user: org.admin, body: { email, role: 'admin' } });
    expect(told()).toEqual({ [email]: 'admin' });
    // A cashier in another org: still an admin here.
    const other = await seedOrg();
    calls = [];
    await invite(other, email);
    expect(told()).toEqual({ [email]: 'admin' });
    calls = [];
    await apiWith(CLIENT, 'PATCH', `/organizations/${org.orgId}/members/${invited.body.id}`, { user: org.admin, body: { role: 'cashier' } });
    expect(told()).toEqual({ [email]: 'member' });
    // Whoever creates an organisation is its admin.
    calls = [];
    const sub = `creator-${crypto.randomUUID()}`;
    const creator = { sub, issuer: ISSUER, name: 'Maker', email: `${sub}@test` };
    expect((await apiWith(CLIENT, 'POST', '/organizations', { user: creator, body: { name: 'Nieuw' } })).status).toBe(201);
    expect(told()).toEqual({ [creator.email]: 'admin' });
  });

  it("the installation's own admins (exact addresses on its list) are client admins, never unassigned", async () => {
    const env = { ...CLIENT, INSTANCE_ADMIN_EMAILS: 'Owner@Frigg.test, *@test' };
    const org = await seedOrg();
    await apiWith(env, 'GET', '/organizations', { user: org.admin });
    expect(told()).toMatchObject({ 'owner@frigg.test': 'admin', [org.cashier.email.toLowerCase()]: 'member' });
    expect(Object.keys(told())).not.toContain('*@test');
    // Invited as a cashier and removed again: still an admin.
    calls = [];
    const invited = await apiWith(env, 'POST', `/organizations/${org.orgId}/members`, { user: org.admin, body: { email: 'owner@frigg.test', role: 'cashier' } });
    expect(told()).toEqual({ 'owner@frigg.test': 'admin' });
    calls = [];
    await apiWith(env, 'DELETE', `/organizations/${org.orgId}/members/${invited.body.id}`, { user: org.admin });
    expect(told()).toEqual({ 'owner@frigg.test': 'admin' });
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

  it('an import assigns its members with their roles; aborting it unassigns who came only with it, never the importer', async () => {
    const source = await seedOrg();
    const file = (await apiWith(CLIENT, 'GET', `/organizations/${source.orgId}/export`, { user: source.admin })).body;
    const sub = `importer-${crypto.randomUUID()}`;
    const importer = { sub, issuer: ISSUER, name: 'Importeur', email: `${sub}@test` };
    const only = [`only-${crypto.randomUUID()}@test`, `only-${crypto.randomUUID()}@test`];
    const members = [
      { ...file.tables.memberships[0], invited_email: only[0], role: 'admin', id: crypto.randomUUID() },
      { ...file.tables.memberships[0], invited_email: only[1], role: 'cashier', id: crypto.randomUUID() },
      { ...file.tables.memberships[0], invited_email: importer.email, id: crypto.randomUUID() },
    ];
    const manifest = { format: file.format, version: file.version, organization: file.organization, counts: { ...Object.fromEntries(Object.entries(file.tables).map(([k, v]) => [k, (v as unknown[]).length])), memberships: members.length } };
    const start = await apiWith(CLIENT, 'POST', '/organizations/import/start', { user: importer, body: { manifest } });
    expect(start.status).toBe(201);
    expect(told()).toEqual({ [importer.email]: 'admin' });
    calls = [];
    await apiWith(CLIENT, 'POST', `/organizations/${start.body.orgId}/import/chunk`, { user: importer, body: { table: 'memberships', rows: members } });
    expect(told()).toEqual({ [only[0]]: 'admin', [only[1]]: 'member', [importer.email]: 'admin' });

    calls = [];
    expect((await apiWith(CLIENT, 'POST', `/organizations/${start.body.orgId}/import/abort`, { user: importer })).status).toBe(200);
    expect(told()).toEqual({ [only[0]]: 'removed', [only[1]]: 'removed' });
  });

  it('the console landing list assigns every member again with its role, at most every few hours', async () => {
    const org = await seedOrg();
    await apiWith(CLIENT, 'GET', '/organizations', { user: org.admin });
    const bulk = calls.filter((c) => c.method === 'POST');
    expect(bulk.length).toBeGreaterThan(0);
    expect(told()).toMatchObject({ [org.admin.email.toLowerCase()]: 'admin', [org.cashier.email.toLowerCase()]: 'member' });
    expect(bulk.every((c) => (c.body as { users: unknown[] }).users.length <= 500)).toBe(true);

    calls = [];
    await apiWith(CLIENT, 'GET', '/organizations', { user: org.admin });
    expect(calls).toEqual([]);
  });
});
