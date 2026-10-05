// The payment and ledger routes (reached through the bff's /api/bancontact)
// are for an active admin or cashier of the org involved only: signed out →
// 401, signed in but not a member of that org (or no longer one) → 403.
// The charge routes take the org from the charge itself, never from the body.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, createTab, DEVICE, line, rows, seedOrg } from './helpers';

describe('payment routes: members of the org only', () => {
  it('refuse a signed-out caller and a member of another org; a cashier of the org goes on', async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const cases: [string, string, Record<string, unknown> | undefined][] = [
      ['POST', '/payments', { orgId: org.orgId, amount: 500 }],
      ['POST', '/sumup/charge', { orgId: org.orgId, method: 'cash', amount: 500, ...DEVICE }],
      ['GET', `/sumup/readers?org_id=${org.orgId}`, undefined],
      ['POST', '/transactions', { orgId: org.orgId, amountCents: 500, method: 'cash', items: {} }],
    ];
    for (const [method, path, body] of cases) {
      expect((await api(method, path, { user: null, body })).status, `${method} ${path} signed out`).toBe(401);
      expect((await api(method, path, { user: other.admin, body })).status, `${method} ${path} other org`).toBe(403);
      const ok = await api(method, path, { user: org.cashier, body });
      expect([401, 403], `${method} ${path} member`).not.toContain(ok.status);
    }
    // Nothing was written for the refused ones.
    expect(await rows('SELECT id FROM charges WHERE org_id = ?', org.orgId)).toHaveLength(1); // the cashier's own cash charge
    expect(await rows('SELECT id FROM transactions WHERE org_id = ?', org.orgId)).toHaveLength(1);
  });

  it("a charge's status and confirmation: only for a member of the charge's own org, whatever the body says", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const tab = await createTab(org, { lines: [line('bon', 'Bon', 100, 3)] });
    const charge = await api('POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, method: 'cash', tabId: tab.id, amount: 300, ...DEVICE } });
    expect(charge.status).toBe(201);
    const chargeId = charge.body.chargeId as string;

    expect((await api('GET', `/sumup/status/${chargeId}`, { user: null })).status).toBe(401);
    expect((await api('GET', `/sumup/status/${chargeId}`, { user: other.admin })).status).toBe(403);
    expect((await api('GET', `/sumup/status/${chargeId}`, { user: org.cashier })).status).toBe(200);

    expect((await api('POST', '/sumup/confirm', { user: null, body: { chargeId } })).status).toBe(401);
    expect((await api('POST', '/sumup/confirm', { user: other.admin, body: { chargeId, orgId: other.orgId } })).status).toBe(403);
    const still = await env.DB.prepare('SELECT status FROM charges WHERE id = ?').bind(chargeId).first<{ status: string }>();
    expect(still!.status).toBe('pending');
    expect((await api('POST', '/sumup/confirm', { user: org.cashier, body: { chargeId } })).status).toBe(200);
    expect((await env.DB.prepare('SELECT status FROM charges WHERE id = ?').bind(chargeId).first<{ status: string }>())!.status).toBe('succeeded');
  });

  it('a removed member is refused too', async () => {
    const org = await seedOrg();
    await env.DB.prepare("UPDATE memberships SET status = 'removed' WHERE org_id = ? AND user_sub = ?").bind(org.orgId, org.cashier.sub).run();
    expect((await api('POST', '/transactions', { user: org.cashier, body: { orgId: org.orgId, amountCents: 500, method: 'cash', items: {} } })).status).toBe(403);
  });
});
