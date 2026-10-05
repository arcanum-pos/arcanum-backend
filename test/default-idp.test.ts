// The instance's login provider: the `default` identity provider seeded
// from DEFAULT_IDP_* (what the installer sets on a self-hosted
// installation) — the only one, for every org (hosting plan phase 6).
// Google rejects the default `offline_access` scope and needs a separate
// client for browser login, so both can be seeded too.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDefaultOrganization, resolveIdentityProviderForAuth } from '../src/organizations/identity-providers';
import { api, apiWith, seedOrg } from './helpers';

const DISCOVERY = {
  issuer: 'https://accounts.google.test',
  authorization_endpoint: 'https://accounts.google.test/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.google.test/token',
  userinfo_endpoint: 'https://openidconnect.google.test/v1/userinfo',
  device_authorization_endpoint: 'https://oauth2.google.test/device/code',
};

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM identity_providers WHERE org_id = 'default'`).run();
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    if (url === 'https://accounts.google.test/.well-known/openid-configuration') return Response.json(DISCOVERY);
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const base = { DEFAULT_IDP_ISSUER_URL: 'https://accounts.google.test', DEFAULT_IDP_CLIENT_ID: 'tv-client', DEFAULT_IDP_CLIENT_SECRET: 'tv-secret' };

describe('default login provider seed', () => {
  it('seeds the scopes and a separate browser-login client when given', async () => {
    const e = { ...env, ...base, DEFAULT_IDP_SCOPES: 'openid profile email', DEFAULT_IDP_AUTH_CODE_CLIENT_ID: 'web-client', DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET: 'web-secret' } as any;
    await ensureDefaultOrganization(e);
    const row = await env.DB.prepare(`SELECT scopes, client_id, auth_code_client_id FROM identity_providers WHERE org_id = 'default'`).first();
    expect(row).toEqual({ scopes: 'openid profile email', client_id: 'tv-client', auth_code_client_id: 'web-client' });

    // Browser login uses the web client; device login (the kassa) the other one.
    const authcode = await resolveIdentityProviderForAuth(e, 'authcode');
    expect([authcode?.clientId, authcode?.clientSecret, authcode?.scopes]).toEqual(['web-client', 'web-secret', 'openid profile email']);
    const device = await resolveIdentityProviderForAuth(e, 'device');
    expect([device?.clientId, device?.clientSecret]).toEqual(['tv-client', 'tv-secret']);
  });

  it('keeps the old behaviour without them (default scopes, one client for both)', async () => {
    await ensureDefaultOrganization({ ...env, ...base } as any);
    const row = await env.DB.prepare(`SELECT scopes, auth_code_client_id, auth_code_client_secret_ciphertext FROM identity_providers WHERE org_id = 'default'`).first();
    expect(row).toEqual({ scopes: null, auth_code_client_id: null, auth_code_client_secret_ciphertext: null });
  });

  it('ignores a browser-login client id without its secret', async () => {
    await ensureDefaultOrganization({ ...env, ...base, DEFAULT_IDP_AUTH_CODE_CLIENT_ID: 'web-client' } as any);
    const row = await env.DB.prepare(`SELECT auth_code_client_id FROM identity_providers WHERE org_id = 'default'`).first();
    expect(row).toEqual({ auth_code_client_id: null });
  });
});

// The bff signs people in with its own DEFAULT_IDP_*: the backend no longer
// hands the instance's client secret out — not even with the old bff key.
describe('GET /identity-provider/resolve (removed)', () => {
  it('is gone, also the legacy per-org path', async () => {
    const bff = { Authorization: 'Bearer test-bff-key' };
    expect((await apiWith(base, 'GET', '/identity-provider/resolve?purpose=device', { headers: bff })).status).toBe(404);
    expect((await apiWith(base, 'GET', '/organizations/default/identity-provider/resolve?purpose=device', { headers: bff })).status).toBe(404);
  });
});

describe('removed per-org custom domain and identity provider API', () => {
  it('is gone', async () => {
    const { orgId, admin } = await seedOrg();
    for (const [method, suffix] of [
      ['GET', 'custom-domain'],
      ['PUT', 'custom-domain'],
      ['DELETE', 'custom-domain'],
      ['POST', 'custom-domain/verify'],
      ['GET', 'identity-provider'],
      ['PUT', 'identity-provider'],
    ]) {
      const res = await api(method, `/organizations/${orgId}/${suffix}`, { user: admin, body: method === 'GET' ? undefined : {} });
      expect(res.status, `${method} ${suffix}`).toBe(404);
    }
  });

  it('an organization no longer carries custom-domain fields', async () => {
    const { orgId, admin } = await seedOrg();
    const res = await api('GET', `/organizations/${orgId}`, { user: admin });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).filter((k) => k.startsWith('customDomain'))).toEqual([]);
  });
});
