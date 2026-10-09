// The installation's mail account (MAIL_CONFIG, MAIL.md phase 2): when the
// installer set one, every organisation's mail goes through it — in the
// mailer's one contract, with the organisation as the sender's name — and
// an invite says whether its mail went out. Without one: the per-org and
// `default` settings, as before (until phase 4). The issuer comes straight
// from DEFAULT_IDP_ISSUER_URL.
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { apiWith, recordedCalls, seedOrg } from './helpers';

const BREVO = JSON.stringify({ provider: 'brevo', apiKey: 'xkeysib-test', fromAddress: 'noreply@scouts.test' });
const invite = (org: Awaited<ReturnType<typeof seedOrg>>, overrides: Record<string, string | undefined>, email = `${crypto.randomUUID()}@example.test`) =>
  apiWith(overrides, 'POST', `/organizations/${org.orgId}/members`, { user: org.admin, body: { email, role: 'cashier' } }).then((res) => ({ res, email }));

describe('MAIL_CONFIG', () => {
  it('an invite goes through the installation\'s account, in the mailer\'s contract, with the organisation as sender name', async () => {
    const org = await seedOrg();
    await env.DB.prepare("UPDATE organizations SET name = 'Scouts Elewijt' WHERE id = ?").bind(org.orgId).run();
    const { res, email } = await invite(org, { MAIL_CONFIG: BREVO });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mailSent: true, loginUrl: `${env.PUBLIC_BASE_URL}/login` });
    const sent = (await recordedCalls('mailer')).filter((c) => c.body?.message?.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.provider).toEqual({ type: 'brevo', apiKey: 'xkeysib-test', fromAddress: 'noreply@scouts.test' });
    expect(sent[0].body.message).toMatchObject({ to: email, fromName: 'Scouts Elewijt' });
    expect(sent[0].body.message.subject).toBeTruthy();
  });

  it('the older form with "credentials" works too', async () => {
    const org = await seedOrg();
    const smtp = { host: 'smtp.mail.me.com', port: 587, username: 'u@icloud.com', password: 'p', fromAddress: 'bert@kaboutersoft.be' };
    const { email } = await invite(org, { MAIL_CONFIG: JSON.stringify({ provider: 'smtp', credentials: smtp }) });
    const sent = (await recordedCalls('mailer')).find((c) => c.body?.message?.to === email)!;
    expect(sent.body.provider).toEqual({ type: 'smtp', ...smtp });
  });

  it('the mailer refusing, or a broken MAIL_CONFIG: the invite is still made — mailSent false', async () => {
    const org = await seedOrg();
    const spy = vi.spyOn(env.ARCANUM_MAILER_SERVICE, 'fetch').mockResolvedValueOnce(Response.json({ ok: false, code: 'auth_failed' }, { status: 502 }));
    const refused = await invite(org, { MAIL_CONFIG: BREVO });
    expect(refused.res.status).toBe(201);
    expect(refused.res.body.mailSent).toBe(false);
    spy.mockRestore();
    const broken = await invite(org, { MAIL_CONFIG: '{"apiKey":"x"}' });
    expect(broken.res.status).toBe(201);
    expect(broken.res.body.mailSent).toBe(false);
  });

  it("the console's test mail tests the installation's account", async () => {
    const org = await seedOrg();
    const res = await apiWith({ MAIL_CONFIG: BREVO }, 'POST', `/organizations/${org.orgId}/smtp-credentials/test`, { user: org.admin });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, provider: 'brevo' });
    expect((await recordedCalls('mailer')).at(-1)!.body).toMatchObject({ provider: { type: 'brevo' }, message: { to: org.admin.email } });
  });
});

describe('the issuer', () => {
  it('comes straight from DEFAULT_IDP_ISSUER_URL — no copied row, no client secret needed (demo orgs)', async () => {
    await env.DB.prepare("DELETE FROM identity_providers WHERE org_id = 'default'").run();
    const sub = `guest-${crypto.randomUUID()}`;
    const res = await apiWith(
      { ORG_CREATION: 'internal', DEFAULT_IDP_ISSUER_URL: 'https://login.test/', DEFAULT_IDP_CLIENT_ID: undefined, DEFAULT_IDP_CLIENT_SECRET: undefined },
      'POST',
      '/internal/demo-orgs',
      { headers: { Authorization: 'Bearer test-bootstrap-key' }, body: { sub, email: `${sub}@guest.invalid`, name: 'Gast' } }
    );
    expect(res.status).toBe(201);
    const member = await env.DB.prepare('SELECT issuer FROM memberships WHERE user_sub = ?').bind(sub).first<{ issuer: string }>();
    expect(member!.issuer).toBe('https://login.test/');
  });
});
