// The customer display's branding (src/branding.ts): an admin sets the
// organisation's logo and two colours, an event may have its own colours,
// and a display reads what applies — publicly, like an org's app icons.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { pngSize } from '../src/org-icons';
import { api, seedOrg, type TestOrg } from './helpers';

function png(width: number, height = width): string {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return btoa(String.fromCharCode(...bytes));
}
const branding = (org: TestOrg, suffix = '') => `/organizations/${org.orgId}/branding${suffix}`;
const shown = async (org: TestOrg, event?: string) =>
  (await SELF.fetch(`https://backend.test/public/branding/${org.orgId}${event ? `?event=${event}` : ''}`)).json() as Promise<{ primary: string | null; accent: string | null; logoUrl: string | null }>;

describe("the customer display's branding", () => {
  it('none at first; an admin sets two colours (normalised), one at a time keeps the other, null clears', async () => {
    const org = await seedOrg();
    expect((await api('GET', branding(org), { user: org.cashier })).body).toEqual({ primary: null, accent: null, logo: null });
    expect(await shown(org)).toEqual({ primary: null, accent: null, logoUrl: null });

    expect((await api('PUT', branding(org), { user: org.admin, body: { primary: '#1F6B3A', accent: '#f2c500' } })).body).toEqual({ primary: '#1f6b3a', accent: '#f2c500', logo: null });
    expect((await api('PUT', branding(org), { user: org.admin, body: { accent: null } })).body).toMatchObject({ primary: '#1f6b3a', accent: null });
    expect(await shown(org)).toEqual({ primary: '#1f6b3a', accent: null, logoUrl: null });
  });

  it('refuses a colour that is not #rrggbb, and anyone but an admin', async () => {
    const org = await seedOrg();
    for (const bad of ['green', '#fff', '#12345g', 12]) {
      const res = await api('PUT', branding(org), { user: org.admin, body: { primary: bad } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('branding_color_invalid');
    }
    expect((await api('PUT', branding(org), { user: org.cashier, body: { primary: '#000000' } })).status).toBe(403);
    expect((await api('PUT', branding(org, '/logo'), { user: org.cashier, body: { png: png(64) } })).status).toBe(403);
    expect((await api('GET', branding(org), { user: null })).status).toBe(401);
  });

  it('a logo: only a real PNG up to 512 px a side; served publicly with a new address each time; removed again', async () => {
    const org = await seedOrg();
    for (const bad of [png(513, 100), 'bm90IGEgcG5n', png(0, 10)]) {
      const res = await api('PUT', branding(org, '/logo'), { user: org.admin, body: { png: bad } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('branding_logo_invalid');
    }
    const set = await api('PUT', branding(org, '/logo'), { user: org.admin, body: { png: png(512, 200) } });
    expect(set.body.logo).toEqual({ updatedAt: expect.any(String) });
    const { logoUrl } = await shown(org);
    expect(logoUrl).toMatch(new RegExp(`^/api/public/branding/${org.orgId}/logo\\.png\\?v=`));
    const res = await SELF.fetch(`https://backend.test${logoUrl!.replace('/api/public', '/public')}`);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(pngSize(new Uint8Array(await res.arrayBuffer()))).toEqual({ width: 512, height: 200 });
    // Colours set afterwards keep the logo.
    await api('PUT', branding(org), { user: org.admin, body: { primary: '#003399' } });
    expect((await shown(org)).logoUrl).toBe(logoUrl);

    expect((await api('DELETE', branding(org, '/logo'), { user: org.admin })).body).toMatchObject({ primary: '#003399', logo: null });
    expect((await shown(org)).logoUrl).toBeNull();
    expect((await SELF.fetch(`https://backend.test/public/branding/${org.orgId}/logo.png`)).status).toBe(404);
  });

  it("an event's own colours win on the display; unset, the organisation's; another org's event changes nothing", async () => {
    const org = await seedOrg();
    await api('PUT', branding(org), { user: org.admin, body: { primary: '#1f6b3a', accent: '#f2c500' } });
    const event = (await api('POST', `/organizations/${org.orgId}/events`, { user: org.admin, body: { name: 'Voetbaltornooi', date: '2026-11-01' } })).body;
    expect(event.brand).toEqual({ primary: null, accent: null });
    expect(await shown(org, event.id)).toMatchObject({ primary: '#1f6b3a', accent: '#f2c500' });

    const patched = await api('PATCH', `/organizations/${org.orgId}/events/${event.id}`, { user: org.admin, body: { brandPrimary: '#C8102E' } });
    expect(patched.body.brand).toEqual({ primary: '#c8102e', accent: null });
    expect(await shown(org, event.id)).toMatchObject({ primary: '#c8102e', accent: '#f2c500' });
    expect((await api('PATCH', `/organizations/${org.orgId}/events/${event.id}`, { user: org.admin, body: { brandAccent: 'red' } })).status).toBe(400);

    const other = await seedOrg();
    expect(await shown(other, event.id)).toEqual({ primary: null, accent: null, logoUrl: null });
    await api('PATCH', `/organizations/${org.orgId}/events/${event.id}`, { user: org.admin, body: { brandPrimary: null } });
    expect((await shown(org, event.id)).primary).toBe('#1f6b3a');
  });
});
