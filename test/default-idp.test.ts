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

// What arcanum-bff calls before anyone is logged in (bff types.ts resolveIdpSettings).
describe('GET /identity-provider/resolve', () => {
  const bff = { Authorization: 'Bearer test-bff-key' };
  const seeded = { ...base, DEFAULT_IDP_AUTH_CODE_CLIENT_ID: 'web-client', DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET: 'web-secret' };
  const resolve = (path: string) => apiWith(seeded, 'GET', path, { headers: bff });

  // Leftovers of the removed per-org features: an org with its own
  // identity_providers row and a custom_domain — neither may matter anymore.
  async function orgWithLeftovers() {
    const org = await seedOrg();
    const domain = `pos-${crypto.randomUUID()}.example.test`;
    await env.DB.batch([
      env.DB.prepare('UPDATE organizations SET custom_domain = ? WHERE id = ?').bind(domain, org.orgId),
      env.DB.prepare(
        `INSERT INTO identity_providers (org_id, issuer_url, client_id, client_secret_ciphertext, client_secret_iv, authorization_endpoint, token_endpoint, userinfo_endpoint, device_authorization_endpoint, updated_at)
         VALUES (?, 'https://own-idp.test', 'own-client', 'x', 'y', 'https://own-idp.test/a', 'https://own-idp.test/t', 'https://own-idp.test/u', 'https://own-idp.test/d', ?)`
      ).bind(org.orgId, new Date().toISOString()),
    ]);
    return { org, domain };
  }

  it("answers the instance's login provider — no org, no domain in the contract", async () => {
    const res = await resolve('/identity-provider/resolve?purpose=authcode');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issuerUrl: 'https://accounts.google.test',
      clientId: 'web-client',
      clientSecret: 'web-secret',
      connectionName: null,
      scopes: null,
      endpoints: {
        authorization_endpoint: DISCOVERY.authorization_endpoint,
        token_endpoint: DISCOVERY.token_endpoint,
        userinfo_endpoint: DISCOVERY.userinfo_endpoint,
        device_authorization_endpoint: DISCOVERY.device_authorization_endpoint,
        end_session_endpoint: null,
      },
    });
    const device = await resolve('/identity-provider/resolve?purpose=device');
    expect([device.body.clientId, device.body.clientSecret]).toEqual(['tv-client', 'tv-secret']);
  });

  it('ignores an org of its own IdP row or custom domain', async () => {
    await orgWithLeftovers();
    const res = await resolve('/identity-provider/resolve?purpose=device');
    expect(res.body.issuerUrl).toBe('https://accounts.google.test');
  });

  it('the legacy per-org path answers the same for any org id or host (an older bff during a rollout)', async () => {
    const { org, domain } = await orgWithLeftovers();
    for (const segment of [org.orgId, domain, 'arcanum.kaboutersoft.be', 'default', 'no-such-org']) {
      const res = await resolve(`/organizations/${encodeURIComponent(segment)}/identity-provider/resolve?purpose=device`);
      expect(res.status, segment).toBe(200);
      expect(res.body).toMatchObject({ orgId: 'default', customDomain: null, isOwnIdp: false, issuerUrl: 'https://accounts.google.test', clientId: 'tv-client' });
    }
  });

  it('needs the bff key and a purpose', async () => {
    expect((await apiWith(seeded, 'GET', '/identity-provider/resolve?purpose=device')).status).toBe(401);
    expect((await apiWith(seeded, 'GET', '/identity-provider/resolve?purpose=device', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await resolve('/identity-provider/resolve')).status).toBe(400);
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
