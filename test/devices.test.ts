// Devices and pairing codes (src/devices.ts): who may do what, the code's
// rules, and what reaches devicehub — an in-memory registry here, standing
// in for arcanum-devicehub's service binding.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCode } from '../src/devices';
import { api, rows, seedOrg, type TestOrg } from './helpers';

interface Device {
  terminal_id: string;
  org_id: string;
  role: string;
  linked_to: string | null;
  name: string | null;
}

let registry: Map<string, Device>;
let hubCalls: { path: string; auth: string | null; body: any }[];
let hubDown = false;

beforeEach(() => {
  registry = new Map();
  hubCalls = [];
  hubDown = false;
  vi.spyOn(env.ARCANUM_DEVICEHUB_SERVICE, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === 'GET' ? null : await request.json().catch(() => null);
    hubCalls.push({ path: url.pathname + url.search, auth: request.headers.get('Authorization'), body });
    if (hubDown) return Response.json({ error: 'down' }, { status: 503 });
    const p = url.pathname;
    if (p === '/devices/register') {
      // Like devicehub: an existing registration is left as it is.
      if (!registry.has(body.terminal_id)) registry.set(body.terminal_id, { terminal_id: body.terminal_id, org_id: body.org_id, role: body.role, linked_to: null, name: body.name ?? null });
      return Response.json(registry.get(body.terminal_id));
    }
    if (p === '/devices/rename') {
      registry.get(body.terminal_id)!.name = body.name;
      return Response.json(registry.get(body.terminal_id));
    }
    if (p === '/devices/remove') {
      registry.delete(body.terminal_id);
      return Response.json({ ok: true });
    }
    if (p === '/devices/link') {
      registry.get(body.terminal_id)!.linked_to = body.pos_terminal_id;
      return Response.json(registry.get(body.terminal_id));
    }
    if (p === '/devices/unlink') {
      registry.get(body.terminal_id)!.linked_to = null;
      return Response.json(registry.get(body.terminal_id));
    }
    if (p === '/devices/reset') return Response.json({ ok: true });
    if (p === '/devices/unlinked') return Response.json([...registry.values()].filter((d) => d.org_id === url.searchParams.get('org_id') && d.role === 'cfd' && !d.linked_to));
    let m = p.match(/^\/devices\/by-org\/(.+)$/);
    if (m) return Response.json([...registry.values()].filter((d) => d.org_id === decodeURIComponent(m![1])).map((d) => ({ ...d, online: false })));
    m = p.match(/^\/devices\/(.+)\/linked$/);
    if (m) return Response.json([...registry.values()].find((d) => d.linked_to === decodeURIComponent(m![1])) ?? null);
    m = p.match(/^\/devices\/(.+)$/);
    if (m) return registry.has(decodeURIComponent(m[1])) ? Response.json(registry.get(decodeURIComponent(m[1]))) : Response.json({ error: 'Unknown terminal_id' }, { status: 404 });
    return Response.json({ error: 'unexpected' }, { status: 500 });
  });
});
afterEach(() => vi.restoreAllMocks());

const pairings = (org: TestOrg) => `/organizations/${org.orgId}/device-pairings`;
const devices = (org: TestOrg, suffix = '') => `/organizations/${org.orgId}/devices${suffix}`;

async function newCode(org: TestOrg, role = 'pos', name = 'Kassa 1') {
  const res = await api('POST', pairings(org), { user: org.admin, body: { role, name } });
  expect(res.status).toBe(201);
  return res.body as { id: string; code: string; expiresAt: string };
}

const claim = (user: TestOrg['admin'], code: string) => api('POST', '/organizations/device-pairings/claim', { user, body: { code } });

async function pairedKassa(org: TestOrg) {
  const { code } = await newCode(org);
  return (await claim(org.cashier, code)).body.terminalId as string;
}

describe('pairing codes', () => {
  it('an admin makes one: 8 characters without look-alikes, shown XXXX-XXXX, valid 10 minutes, stored only hashed', async () => {
    const org = await seedOrg();
    const res = await api('POST', pairings(org), { user: org.admin, body: { role: 'pos', name: '  Kassa 1 ' } });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(res.body).toMatchObject({ role: 'pos', name: 'Kassa 1', status: 'open', createdBy: 'Admin' });
    const minutes = (Date.parse(res.body.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThanOrEqual(10);
    const stored = await rows<{ code_hash: string }>('SELECT code_hash FROM device_pairings WHERE id = ?', res.body.id);
    expect(stored[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(normalizeCode(res.body.code));
  });

  it('only an admin of the org; a role and a name are required', async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    expect((await api('POST', pairings(org), { user: null, body: { role: 'pos', name: 'K' } })).status).toBe(401);
    expect((await api('POST', pairings(org), { user: org.cashier, body: { role: 'pos', name: 'K' } })).status).toBe(403);
    expect((await api('POST', pairings(org), { user: other.admin, body: { role: 'pos', name: 'K' } })).status).toBe(403);
    expect((await api('POST', pairings(org), { user: org.admin, body: { role: 'sim', name: 'K' } })).status).toBe(400);
    const noName = await api('POST', pairings(org), { user: org.admin, body: { role: 'cfd', name: '  ' } });
    expect(noName.status).toBe(400);
    expect(noName.body.code).toBe('device_name_required');
  });

  it("claimed by a cashier of the org: the device is registered with the code's role, org and name", async () => {
    const org = await seedOrg();
    const { code, id } = await newCode(org, 'cfd', 'Klantscherm toog');
    const res = await claim(org.cashier, code.toLowerCase().replace('-', ' '));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ role: 'cfd', orgId: org.orgId, orgName: 'Test org', name: 'Klantscherm toog' });
    expect(res.body).toHaveProperty('orgLocale');
    expect(registry.get(res.body.terminalId)).toMatchObject({ org_id: org.orgId, role: 'cfd', name: 'Klantscherm toog' });
    expect(hubCalls.every((c) => c.auth === 'Bearer test-internal-key' || c.auth?.startsWith('Bearer '))).toBe(true);
    const list = await api('GET', pairings(org), { user: org.admin });
    expect(list.body.find((p: any) => p.id === id)).toMatchObject({ status: 'claimed', claimedBy: 'Ann', terminalId: res.body.terminalId });
  });

  it('single use; revoked or expired codes are refused with one and the same answer', async () => {
    const org = await seedOrg();
    const used = await newCode(org);
    expect((await claim(org.cashier, used.code)).status).toBe(201);
    const revoked = await newCode(org);
    expect((await api('DELETE', `${pairings(org)}/${revoked.id}`, { user: org.admin })).status).toBe(200);
    const expired = await newCode(org);
    await env.DB.prepare('UPDATE device_pairings SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), expired.id).run();
    for (const code of [used.code, revoked.code, expired.code, 'ABCD-EFGH', 'short']) {
      const res = await claim(org.cashier, code);
      expect(res.status, code).toBe(400);
      expect(res.body.code, code).toBe('pairing_code_invalid');
    }
    expect(registry.size).toBe(1);
  });

  it("a valid code, but someone who isn't a member of its org: told so, and the code stays usable", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const { code } = await newCode(org);
    const res = await claim(other.admin, code);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('pairing_not_member');
    expect((await claim(org.cashier, code)).status).toBe(201);
  });

  it('10 wrong codes in 10 minutes and the person has to wait — even with a good one', async () => {
    const org = await seedOrg();
    const { code } = await newCode(org);
    for (let i = 0; i < 10; i++) expect((await claim(org.cashier, 'WRNG-CODE')).status).toBe(400);
    const res = await claim(org.cashier, code);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('pairing_too_many_attempts');
    // Someone else isn't held back by it.
    expect((await claim(org.admin, code)).status).toBe(201);
  });

  it("devicehub down: the code isn't used up", async () => {
    const org = await seedOrg();
    const { code } = await newCode(org);
    hubDown = true;
    expect((await claim(org.cashier, code)).status).toBe(502);
    hubDown = false;
    expect((await claim(org.cashier, code)).status).toBe(201);
  });

  it("an admin sees the last day's codes and revokes only an open one of their own org", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const open = await newCode(org);
    expect((await api('GET', pairings(org), { user: org.cashier })).status).toBe(403);
    expect((await api('DELETE', `${pairings(other)}/${open.id}`, { user: other.admin })).status).toBe(404);
    expect((await api('DELETE', `${pairings(org)}/${open.id}`, { user: org.admin })).status).toBe(200);
    expect((await api('DELETE', `${pairings(org)}/${open.id}`, { user: org.admin })).status).toBe(404);
    expect((await api('GET', pairings(org), { user: org.admin })).body[0]).toMatchObject({ id: open.id, status: 'revoked' });
  });
});

describe('a pairing code for a customer display, for a given kassa', () => {
  it('links the display to that kassa as soon as it is paired', async () => {
    const org = await seedOrg();
    const kassa = await pairedKassa(org);
    const res = await api('POST', pairings(org), { user: org.admin, body: { role: 'cfd', name: 'Tablet toog', linkTo: kassa } });
    expect(res.body.linkTo).toBe(kassa);
    const claimed = await claim(org.cashier, res.body.code);
    expect(claimed.body.linkedTo).toBe(kassa);
    expect(registry.get(claimed.body.terminalId)!.linked_to).toBe(kassa);
  });

  it("only a kassa of the org; ignored for a kassa code; the kassa gone by then: paired, just not linked", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const theirs = await pairedKassa(other);
    expect((await api('POST', pairings(org), { user: org.admin, body: { role: 'cfd', name: 'X', linkTo: theirs } })).status).toBe(404);
    const kassa = await pairedKassa(org);
    expect((await api('POST', pairings(org), { user: org.admin, body: { role: 'pos', name: 'K', linkTo: kassa } })).body.linkTo).toBeNull();

    const { code } = (await api('POST', pairings(org), { user: org.admin, body: { role: 'cfd', name: 'Tablet', linkTo: kassa } })).body;
    await api('DELETE', devices(org, `/${kassa}`), { user: org.admin });
    const claimed = await claim(org.cashier, code);
    expect(claimed.status).toBe(201);
    expect(claimed.body.linkedTo).toBeNull();
    expect(registry.get(claimed.body.terminalId)!.linked_to).toBeNull();
  });
});

describe('devices', () => {
  it("members list and look up their org's devices; another org's device is \"not found\"", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const kassa = await pairedKassa(org);
    const theirs = await pairedKassa(other);
    expect((await api('GET', devices(org), { user: org.cashier })).body.map((d: any) => d.terminal_id)).toEqual([kassa]);
    expect((await api('GET', devices(org), { user: other.admin })).status).toBe(403);
    expect((await api('GET', devices(org, `/${kassa}`), { user: org.cashier })).body).toMatchObject({ terminal_id: kassa, name: 'Kassa 1' });
    const foreign = await api('GET', devices(org, `/${theirs}`), { user: org.cashier });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('device_not_found');
  });

  it('a member renames a device of their org', async () => {
    const org = await seedOrg();
    const kassa = await pairedKassa(org);
    expect((await api('PATCH', devices(org, `/${kassa}`), { user: org.cashier, body: { name: 'Toog' } })).status).toBe(200);
    expect(registry.get(kassa)!.name).toBe('Toog');
    expect((await api('PATCH', devices(org, `/${kassa}`), { user: org.cashier, body: { name: '' } })).body.code).toBe('device_name_required');
  });

  it('unpairing is for admins only — also the device a cashier is on', async () => {
    const org = await seedOrg();
    const kassa = await pairedKassa(org);
    expect((await api('DELETE', devices(org, `/${kassa}`), { user: org.cashier })).status).toBe(403);
    expect(registry.has(kassa)).toBe(true);
    expect((await api('DELETE', devices(org, `/${kassa}`), { user: org.admin })).status).toBe(200);
    expect(registry.has(kassa)).toBe(false);
  });

  it('"Klantscherm openen": its own customer display, registered and linked at once — the same one every time', async () => {
    const org = await seedOrg();
    const kassa = await pairedKassa(org);
    const res = await api('POST', devices(org, `/${kassa}/display`), { user: org.cashier });
    expect(res.status).toBe(201);
    expect(res.body.terminalId).toBe(`display-of-${kassa}`);
    expect(registry.get(res.body.terminalId)).toMatchObject({ role: 'cfd', org_id: org.orgId, linked_to: kassa, name: 'Kassa 1 · klantscherm' });
    expect((await api('GET', devices(org, `/${kassa}/linked`), { user: org.cashier })).body).toMatchObject({ terminal_id: res.body.terminalId });

    // Again (and after renaming the kassa): the same display, renamed along — nothing piles up.
    await api('PATCH', devices(org, `/${kassa}`), { user: org.cashier, body: { name: 'Toog' } });
    const again = await api('POST', devices(org, `/${kassa}/display`), { user: org.cashier });
    expect(again.body.terminalId).toBe(res.body.terminalId);
    expect(registry.get(again.body.terminalId)).toMatchObject({ linked_to: kassa, name: 'Toog · klantscherm' });
    expect([...registry.values()].filter((d) => d.role === 'cfd')).toHaveLength(1);
  });

  it('"Klantscherm openen" takes over from a separate display that was linked to the kassa', async () => {
    const org = await seedOrg();
    const kassa = await pairedKassa(org);
    const { code } = await newCode(org, 'cfd', 'Tablet');
    const tablet = (await claim(org.cashier, code)).body.terminalId;
    await api('POST', devices(org, `/${kassa}/link`), { user: org.cashier, body: { terminalId: tablet } });
    const window = (await api('POST', devices(org, `/${kassa}/display`), { user: org.cashier })).body.terminalId;
    expect(registry.get(tablet)!.linked_to).toBeNull();
    expect(registry.get(window)!.linked_to).toBe(kassa);
  });

  it("the companion display's name follows the organisation's language", async () => {
    const org = await seedOrg();
    await env.DB.prepare("UPDATE organizations SET locale = 'fr' WHERE id = ?").bind(org.orgId).run();
    const kassa = await pairedKassa(org);
    const res = await api('POST', devices(org, `/${kassa}/display`), { user: org.cashier });
    expect(registry.get(res.body.terminalId)!.name).toBe('Kassa 1 · écran client');
  });

  it("linking only between two devices of the caller's org", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const kassa = await pairedKassa(org);
    const { code } = await newCode(org, 'cfd', 'Scherm');
    const display = (await claim(org.cashier, code)).body.terminalId;
    const { code: theirCode } = await newCode(other, 'cfd', 'Hun scherm');
    const theirDisplay = (await claim(other.cashier, theirCode)).body.terminalId;

    expect((await api('GET', devices(org, `/${kassa}/linkable`), { user: org.cashier })).body.map((d: any) => d.terminal_id)).toEqual([display]);
    expect((await api('POST', devices(org, `/${kassa}/link`), { user: org.cashier, body: { terminalId: theirDisplay } })).status).toBe(404);
    expect((await api('POST', devices(org, `/${kassa}/link`), { user: org.cashier, body: { terminalId: display } })).status).toBe(200);
    expect(registry.get(display)!.linked_to).toBe(kassa);
    expect((await api('POST', devices(org, `/${display}/unlink`), { user: org.cashier })).status).toBe(200);
    expect(registry.get(display)!.linked_to).toBeNull();
    expect((await api('POST', devices(other, `/${kassa}/reset`), { user: other.cashier })).status).toBe(404);
    expect((await api('POST', devices(org, `/${kassa}/reset`), { user: org.cashier })).status).toBe(200);
  });

  it('every device route refuses a signed-out caller and a non-member', async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const kassa = await pairedKassa(org);
    const cases: [string, string, unknown?][] = [
      ['GET', devices(org)],
      ['GET', devices(org, `/${kassa}`)],
      ['PATCH', devices(org, `/${kassa}`), { name: 'X' }],
      ['DELETE', devices(org, `/${kassa}`)],
      ['POST', devices(org, `/${kassa}/display`)],
      ['GET', devices(org, `/${kassa}/linked`)],
      ['GET', devices(org, `/${kassa}/linkable`)],
      ['POST', devices(org, `/${kassa}/link`), { terminalId: kassa }],
      ['POST', devices(org, `/${kassa}/unlink`)],
      ['POST', devices(org, `/${kassa}/reset`)],
      ['GET', pairings(org)],
      ['POST', pairings(org), { role: 'pos', name: 'X' }],
    ];
    for (const [method, path, body] of cases) {
      expect((await api(method, path, { user: null, body })).status, `${method} ${path} signed out`).toBe(401);
      expect((await api(method, path, { user: other.admin, body })).status, `${method} ${path} other org`).toBe(403);
    }
    expect((await claim(null as any, 'ABCD-EFGH')).status).toBe(401);
    expect(registry.size).toBe(1);
  });
});
