// The default login provider seeded from DEFAULT_IDP_* (what the installer
// sets on a self-hosted installation). Google rejects the default
// `offline_access` scope and needs a separate client for browser login, so
// both can be seeded too.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDefaultOrganization, resolveIdentityProviderForAuth } from '../src/organizations/identity-providers';

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
    const authcode = await resolveIdentityProviderForAuth(e, 'default', 'authcode');
    expect([authcode?.clientId, authcode?.clientSecret, authcode?.scopes]).toEqual(['web-client', 'web-secret', 'openid profile email']);
    const device = await resolveIdentityProviderForAuth(e, 'default', 'device');
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
