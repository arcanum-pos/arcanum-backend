// An organisation's own app icons (src/org-icons.ts): admins set one per
// page (and per prep station), anyone may read it — it's on home screens —
// and only real PNGs of the stated sizes are kept.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { pngSize } from '../src/org-icons';
import { api, seedOrg, type TestOrg } from './helpers';

// Just enough of a PNG for the checks: its signature and IHDR (width, height).
function png(width: number, height = width, fill = 0): string {
  const bytes = new Uint8Array(64).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return btoa(String.fromCharCode(...bytes));
}
const set = (fill = 0) => ({ png: { 96: png(96, 96, fill), 180: png(180, 180, fill), 192: png(192, 192, fill), 512: png(512, 512, fill) } });
const icons = (org: TestOrg, suffix = '') => `/organizations/${org.orgId}/icons${suffix}`;
const publicIcon = (org: TestOrg, slot: string, size: number) => SELF.fetch(`https://backend.test/public/icons/${org.orgId}/${slot}/${size}`);

describe("an organisation's app icons", () => {
  it('an admin sets one for a page: read by anyone, per size; removed, back to none (the default)', async () => {
    const org = await seedOrg();
    expect((await api('PUT', icons(org, '/kassa'), { user: org.admin, body: set() })).status).toBe(200);
    expect((await api('GET', icons(org), { user: org.cashier })).body).toEqual([{ slot: 'kassa', updatedAt: expect.any(String) }]);
    const res = await publicIcon(org, 'kassa', 180);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(pngSize(new Uint8Array(await res.arrayBuffer()))).toEqual({ width: 180, height: 180 });
    expect((await publicIcon(org, 'display', 180)).status).toBe(404);
    expect((await publicIcon(org, 'kassa', 64)).status).toBe(404);
    expect((await api('DELETE', icons(org, '/kassa'), { user: org.admin })).status).toBe(200);
    expect((await publicIcon(org, 'kassa', 180)).status).toBe(404);
    expect((await api('GET', icons(org), { user: org.admin })).body).toEqual([]);
  });

  it("per prep station; a station without its own gets the org's station icon", async () => {
    const org = await seedOrg();
    const kitchen = (await api('POST', `/organizations/${org.orgId}/catalog/stations`, { user: org.admin, body: { name: 'Keuken' } })).body;
    const bar = (await api('POST', `/organizations/${org.orgId}/catalog/stations`, { user: org.admin, body: { name: 'Bar' } })).body;
    expect((await publicIcon(org, `station-${bar.id}`, 192)).status).toBe(404);
    await api('PUT', icons(org, `/station-${kitchen.id}`), { user: org.admin, body: set(1) });
    await api('PUT', icons(org, '/station'), { user: org.admin, body: set(2) });
    const kitchenPng = new Uint8Array(await (await publicIcon(org, `station-${kitchen.id}`, 192)).arrayBuffer())
    const barPng = new Uint8Array(await (await publicIcon(org, `station-${bar.id}`, 192)).arrayBuffer())
    expect(kitchenPng[40]).toBe(1);
    expect(barPng[40]).toBe(2);
    // Not another org's station.
    const other = await seedOrg();
    expect((await api('PUT', icons(other, `/station-${kitchen.id}`), { user: other.admin, body: set() })).body.code).toBe('icon_slot_unknown');
  });

  it('admins only; a known page; every size, a real PNG of that size', async () => {
    const org = await seedOrg();
    expect((await api('PUT', icons(org, '/kassa'), { user: org.cashier, body: set() })).status).toBe(403);
    expect((await api('DELETE', icons(org, '/kassa'), { user: org.cashier })).status).toBe(403);
    expect((await api('PUT', icons(org, '/kassa'), { user: null, body: set() })).status).toBe(401);
    expect((await api('PUT', icons(org, '/start'), { user: org.admin, body: set() })).body.code).toBe('icon_slot_unknown');
    // The console's: per organisation too.
    expect((await api('PUT', icons(org, '/console'), { user: org.admin, body: set() })).status).toBe(200);
    const wrongSize = { png: { ...set().png, 180: png(200) } };
    expect((await api('PUT', icons(org, '/kassa'), { user: org.admin, body: wrongSize })).body).toMatchObject({ code: 'icon_invalid', params: { size: 180 } });
    const notPng = { png: { ...set().png, 96: btoa('<svg/>') } };
    expect((await api('PUT', icons(org, '/kassa'), { user: org.admin, body: notPng })).body.code).toBe('icon_invalid');
    const missing = { png: { 96: png(96) } };
    expect((await api('PUT', icons(org, '/kassa'), { user: org.admin, body: missing })).body.code).toBe('icon_invalid');
    // Nothing kept from a refused upload.
    expect((await publicIcon(org, 'kassa', 96)).status).toBe(404);
    expect((await publicIcon(org, 'console', 96)).status).toBe(200);
  });
});
