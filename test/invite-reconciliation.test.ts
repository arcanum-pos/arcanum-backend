// A pending invite (keyed by e-mail) becomes an active membership on the
// invitee's first login — but only for an identity from this instance's
// login provider, and never on an e-mail the provider explicitly marked
// unverified (the bff forwards `email_verified` as X-User-Email-Verified).
import { describe, expect, it } from 'vitest';
import { api, apiWith, rows, seedOrg, type TestUser } from './helpers';

const ISSUER = 'https://issuer.test/';

// The installation's issuer is DEFAULT_IDP_ISSUER_URL (vitest.config.mts: ISSUER).
function invitee(issuer = ISSUER): TestUser {
  const sub = `invitee-${crypto.randomUUID()}`;
  return { sub, issuer, name: 'Invitee', email: `${sub}@test` };
}

async function invite(user: TestUser) {
  const org = await seedOrg();
  const res = await api('POST', `/organizations/${org.orgId}/members`, { user: org.admin, body: { email: user.email, role: 'cashier' } });
  expect(res.status).toBe(201);
  return org;
}

// The invitee's first call after logging in, as the bff sends it.
function login(user: TestUser, emailVerified?: 'true' | 'false') {
  return apiWith({}, 'GET', '/organizations/memberships', { user, headers: emailVerified ? { 'X-User-Email-Verified': emailVerified } : {} });
}

async function membershipStatus(orgId: string, email: string) {
  const [row] = await rows<{ status: string; user_sub: string | null }>('SELECT status, user_sub FROM memberships WHERE org_id = ? AND invited_email = ?', orgId, email);
  return row;
}

describe('reconcilePendingInvites', () => {
  it('activates the invite on a verified e-mail', async () => {
    const user = invitee();
    const org = await invite(user);
    const res = await login(user, 'true');
    expect(res.body).toEqual([expect.objectContaining({ orgId: org.orgId, role: 'cashier' })]);
    expect(await membershipStatus(org.orgId, user.email)).toEqual({ status: 'active', user_sub: user.sub });
  });

  it('keeps today\'s behaviour when the provider sends no email_verified claim', async () => {
    const user = invitee();
    const org = await invite(user);
    const res = await login(user);
    expect(res.body).toHaveLength(1);
    expect((await membershipStatus(org.orgId, user.email)).status).toBe('active');
  });

  it('never activates it on an e-mail marked unverified — the invite waits for a verified login', async () => {
    const user = invitee();
    const org = await invite(user);
    expect((await login(user, 'false')).body).toEqual([]);
    expect(await membershipStatus(org.orgId, user.email)).toEqual({ status: 'pending', user_sub: null });

    // Once the address is verified at the provider, the same invite goes through.
    expect((await login(user, 'true')).body).toHaveLength(1);
    expect((await membershipStatus(org.orgId, user.email)).status).toBe('active');
  });

  it('also on the admin-portal org list', async () => {
    const user = invitee();
    const org = await invite(user);
    await apiWith({}, 'GET', '/organizations', { user, headers: { 'X-User-Email-Verified': 'false' } });
    expect((await membershipStatus(org.orgId, user.email)).status).toBe('pending');
  });

  it('the issuer is DEFAULT_IDP_ISSUER_URL, as the installer sets it — another one in it, another check', async () => {
    const other = { DEFAULT_IDP_ISSUER_URL: 'https://someone-elses-idp.test/' };
    const member = invitee();
    const org = await invite(member);
    await apiWith(other, 'GET', '/organizations/memberships', { user: member, headers: { 'X-User-Email-Verified': 'true' } });
    expect((await membershipStatus(org.orgId, member.email)).status).toBe('pending');
    const stranger = invitee('https://someone-elses-idp.test/');
    const strangerOrg = await invite(stranger);
    await apiWith(other, 'GET', '/organizations/memberships', { user: stranger, headers: { 'X-User-Email-Verified': 'true' } });
    expect((await membershipStatus(strangerOrg.orgId, stranger.email))).toMatchObject({ status: 'active', user_sub: stranger.sub });
  });

  it('ignores an identity from another issuer than the instance\'s login provider', async () => {
    const user = invitee('https://someone-elses-idp.test/');
    const org = await invite(user);
    expect((await login(user, 'true')).body).toEqual([]);
    expect((await membershipStatus(org.orgId, user.email)).status).toBe('pending');
  });
});
