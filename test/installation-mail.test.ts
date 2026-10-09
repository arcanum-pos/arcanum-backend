// The installation's mail account (MAIL_CONFIG, MAIL.md phase 2): when the
// installer set one, every organisation's mail goes through it — in the
// mailer's one contract, with the organisation as the sender's name — and
// an invite says whether its mail went out. Without one, invites aren't
// mailed (phase 4: the old per-org and `default` settings are gone). The issuer comes straight
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

});

describe('the issuer', () => {
  it('comes straight from DEFAULT_IDP_ISSUER_URL — no copied row, no client secret needed (demo orgs)', async () => {
    const sub = `guest-${crypto.randomUUID()}`;
    const res = await apiWith(
      { ORG_CREATION: 'internal', DEFAULT_IDP_ISSUER_URL: 'https://login.test/' },
      'POST',
      '/internal/demo-orgs',
      { headers: { Authorization: 'Bearer test-bootstrap-key' }, body: { sub, email: `${sub}@guest.invalid`, name: 'Gast' } }
    );
    expect(res.status).toBe(201);
    const member = await env.DB.prepare('SELECT issuer FROM memberships WHERE user_sub = ?').bind(sub).first<{ issuer: string }>();
    expect(member!.issuer).toBe('https://login.test/');
  });
});

describe("the installer's test mail (POST /organizations/mail-test)", () => {
  const boss = { sub: 'boss-1', issuer: 'https://issuer.test/', name: 'Boss', email: 'boss@example.test' };
  const verified = { 'X-User-Email-Verified': 'true' };

  it('an instance admin: one mail to their own address through the live MAIL_CONFIG, with the mailer\'s verdict', async () => {
    const res = await apiWith({ MAIL_CONFIG: BREVO }, 'POST', '/organizations/mail-test', { user: boss, headers: verified });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, provider: 'brevo', to: 'boss@example.test' });
    // A real invitation, from the installation's first organisation.
    const sent = (await recordedCalls('mailer')).at(-1)!.body;
    expect(sent.provider).toMatchObject({ type: 'brevo' });
    expect(sent.message.to).toBe('boss@example.test');
    expect(sent.message.subject).toMatch(/^Uitnodiging voor /);
    expect(sent.message.text).toContain('/login');
    expect(sent.message.fromName).toBe(sent.message.subject.replace('Uitnodiging voor ', ''));
  });

  it('to another address when given (a checker like mail-tester.com); not to something that is no address', async () => {
    const to = 'test-abc123@srv1.mail-tester.com';
    const res = await apiWith({ MAIL_CONFIG: BREVO }, 'POST', '/organizations/mail-test', { user: { ...boss, sub: 'boss-to', email: 'boss-to@test' }, headers: verified, body: { to } });
    expect(res.body).toMatchObject({ ok: true, to });
    expect((await recordedCalls('mailer')).at(-1)!.body.message.to).toBe(to);
    const bad = await apiWith({ MAIL_CONFIG: BREVO }, 'POST', '/organizations/mail-test', { user: boss, headers: verified, body: { to: 'geen adres' } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_email');
  });

  it('at most 10 an hour per admin', async () => {
    const busy = { ...boss, sub: 'boss-busy', email: 'busy@test' };
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await apiWith({ MAIL_CONFIG: BREVO }, 'POST', '/organizations/mail-test', { user: busy, headers: verified })).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });

  it("the mailer's refusal comes back as it is (code and detail)", async () => {
    const spy = vi.spyOn(env.ARCANUM_MAILER_SERVICE, 'fetch').mockResolvedValueOnce(Response.json({ ok: false, code: 'auth_failed', error: 'Brevo refused the API key (401)', detail: 'Key not found' }, { status: 502 }));
    const res = await apiWith({ MAIL_CONFIG: BREVO }, 'POST', '/organizations/mail-test', { user: boss, headers: verified });
    spy.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, code: 'auth_failed', detail: 'Key not found', provider: 'brevo' });
  });

  it('nothing set up: says so; a malformed one: invalid_config', async () => {
    expect((await apiWith({ MAIL_CONFIG: undefined }, 'POST', '/organizations/mail-test', { user: boss, headers: verified })).body.code).toBe('mail_not_configured');
    expect((await apiWith({ MAIL_CONFIG: '{"apiKey":"x"}' }, 'POST', '/organizations/mail-test', { user: boss, headers: verified })).body.code).toBe('invalid_config');
  });

  it('only an instance admin with a verified address', async () => {
    const org = await seedOrg();
    expect((await apiWith({ MAIL_CONFIG: BREVO, INSTANCE_ADMIN_EMAILS: 'boss@example.test' }, 'POST', '/organizations/mail-test', { user: org.admin, headers: verified })).status).toBe(403);
    expect((await apiWith({ MAIL_CONFIG: BREVO, INSTANCE_ADMIN_EMAILS: 'boss@example.test' }, 'POST', '/organizations/mail-test', { user: boss, headers: { 'X-User-Email-Verified': 'false' } })).status).toBe(403);
    expect((await apiWith({ MAIL_CONFIG: BREVO }, 'POST', '/organizations/mail-test', { user: null })).status).toBe(401);
  });
});
