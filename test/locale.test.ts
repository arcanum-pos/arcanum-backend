// An organisation's default language (organizations.locale, 'nl' | 'fr' |
// 'en'): the locale API, where it shows up, export/import, and the invite
// mail it picks the language of.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildInviteEmail } from '../src/email-templates/invite';
import { api, recordedCalls, rows, seedOrg, type TestOrg, type TestUser } from './helpers';

const localePath = (org: TestOrg) => `/organizations/${org.orgId}/locale`;

function importer(): TestUser {
  const sub = `importer-${crypto.randomUUID()}`;
  return { sub, issuer: 'https://new-instance.test/', name: 'Nieuwe beheerder', email: `${sub}@test` };
}

describe('organizations.locale', () => {
  it("defaults to 'nl' and only accepts nl, fr, en", async () => {
    const org = await seedOrg();
    expect((await rows<{ locale: string }>('SELECT locale FROM organizations WHERE id = ?', org.orgId))[0].locale).toBe('nl');
    await expect(env.DB.prepare(`UPDATE organizations SET locale = 'de' WHERE id = ?`).bind(org.orgId).run()).rejects.toThrow(/CHECK/);
  });
});

describe('GET/PUT /organizations/:orgId/locale', () => {
  it('any member can read it; only an admin can change it', async () => {
    const org = await seedOrg();
    expect(await api('GET', localePath(org), { user: org.cashier })).toEqual({ status: 200, body: { locale: 'nl' } });

    expect((await api('PUT', localePath(org), { user: org.cashier, body: { locale: 'fr' } })).status).toBe(403);
    expect(await api('PUT', localePath(org), { user: org.admin, body: { locale: 'fr' } })).toEqual({ status: 200, body: { locale: 'fr' } });
    expect((await api('GET', localePath(org), { user: org.cashier })).body).toEqual({ locale: 'fr' });
  });

  it('refuses anything but nl, fr or en (400), and strangers (401/403)', async () => {
    const org = await seedOrg();
    for (const locale of ['de', 'NL', '', null, 3]) {
      const res = await api('PUT', localePath(org), { user: org.admin, body: { locale } });
      expect(res.status, String(locale)).toBe(400);
    }
    expect((await api('PUT', localePath(org), { user: org.admin, body: {} })).status).toBe(400);
    expect((await api('GET', localePath(org), { user: null })).status).toBe(401);
    const other = await seedOrg();
    expect((await api('GET', localePath(org), { user: other.admin })).status).toBe(403);
    expect((await api('GET', localePath(org), { user: org.admin })).body).toEqual({ locale: 'nl' });
  });

  it('shows on the org itself, the admin org list and the memberships list', async () => {
    const org = await seedOrg();
    await api('PUT', localePath(org), { user: org.admin, body: { locale: 'en' } });
    expect((await api('GET', `/organizations/${org.orgId}`, { user: org.cashier })).body.locale).toBe('en');
    const mine = (await api('GET', '/organizations', { user: org.admin })).body as any[];
    expect(mine.find((o) => o.id === org.orgId).locale).toBe('en');
    const memberships = (await api('GET', '/organizations/memberships', { user: org.cashier })).body as any[];
    expect(memberships).toEqual([{ orgId: org.orgId, orgName: 'Test org', orgLocale: 'en', role: 'cashier' }]);
  });
});

describe('export / import carry the locale', () => {
  it('exports it with the organization, and an import keeps it', async () => {
    const org = await seedOrg();
    await api('PUT', localePath(org), { user: org.admin, body: { locale: 'fr' } });
    const file = (await api('GET', `/organizations/${org.orgId}/export`, { user: org.admin })).body;
    expect(file.version).toBe(1);
    expect(file.organization).toMatchObject({ name: 'Test org', locale: 'fr' });

    const user = importer();
    const start = await api('POST', '/organizations/import/start', {
      user,
      body: { manifest: { format: file.format, version: file.version, organization: file.organization, counts: {} } },
    });
    expect(start.status).toBe(201);
    expect((await api('GET', `/organizations/${start.body.orgId}/locale`, { user })).body).toEqual({ locale: 'fr' });
  });

  it("imports an older export without a locale (or an unknown one) as 'nl'", async () => {
    for (const organization of [{ name: 'Oud' }, { name: 'Raar', locale: 'de' }]) {
      const user = importer();
      const start = await api('POST', '/organizations/import/start', {
        user,
        body: { manifest: { format: 'arcanum-org-export', version: 1, organization, counts: {} } },
      });
      expect(start.status).toBe(201);
      expect((await api('GET', `/organizations/${start.body.orgId}/locale`, { user })).body).toEqual({ locale: 'nl' });
    }
  });
});

describe('the invite mail', () => {
  const params = { orgName: 'Scouts <Sint-Jan>', role: 'cashier', loginUrl: 'https://pos.example.test/login' };

  it('is byte-identical in Dutch to what it always was', () => {
    expect(buildInviteEmail({ ...params, locale: 'nl' })).toEqual({
      subject: 'Uitnodiging voor Scouts <Sint-Jan>',
      text: [
        'Je bent uitgenodigd om lid te worden van Scouts <Sint-Jan> op Arcanum, als kassier.',
        '',
        'Meld je aan om je uitnodiging te activeren: https://pos.example.test/login',
        '',
        'Gebruik hetzelfde e-mailadres waarop je deze uitnodiging ontvangen hebt.',
      ].join('\n'),
      html: [
        '<p>Je bent uitgenodigd om lid te worden van <strong>Scouts &lt;Sint-Jan&gt;</strong> op Arcanum, als kassier.</p>',
        '    <p><a href="https://pos.example.test/login">Meld je aan om je uitnodiging te activeren</a></p>',
        '    <p>Gebruik hetzelfde e-mailadres waarop je deze uitnodiging ontvangen hebt.</p>',
      ].join('\n'),
    });
    expect(buildInviteEmail({ ...params, role: 'admin', locale: 'nl' }).text).toContain(', als beheerder.');
  });

  it('is in formal Belgian French', () => {
    const mail = buildInviteEmail({ ...params, locale: 'fr' });
    expect(mail.subject).toBe('Invitation à rejoindre Scouts <Sint-Jan>');
    expect(mail.text).toBe(
      [
        'Vous êtes invité(e) à rejoindre Scouts <Sint-Jan> sur Arcanum, en tant que caissier.',
        '',
        'Connectez-vous pour activer votre invitation : https://pos.example.test/login',
        '',
        'Utilisez l’adresse e-mail à laquelle vous avez reçu cette invitation.',
      ].join('\n')
    );
    expect(mail.html).toContain('<strong>Scouts &lt;Sint-Jan&gt;</strong> sur Arcanum, en tant que caissier.');
    expect(mail.html).toContain('<a href="https://pos.example.test/login">Connectez-vous pour activer votre invitation</a>');
    expect(buildInviteEmail({ ...params, role: 'admin', locale: 'fr' }).text).toContain('en tant qu’administrateur.');
  });

  it('is in British English', () => {
    const mail = buildInviteEmail({ ...params, locale: 'en' });
    expect(mail.subject).toBe('Invitation to join Scouts <Sint-Jan>');
    expect(mail.text).toBe(
      [
        'You have been invited to join Scouts <Sint-Jan> on Arcanum, as a cashier.',
        '',
        'Log in to activate your invitation: https://pos.example.test/login',
        '',
        'Please use the email address at which you received this invitation.',
      ].join('\n')
    );
    expect(mail.html).toContain('<a href="https://pos.example.test/login">Log in to activate your invitation</a>');
    expect(buildInviteEmail({ ...params, role: 'admin', locale: 'en' }).text).toContain('as an administrator.');
  });

  it("is sent in the org's language when a member is invited", async () => {
    const org = await seedOrg();
    const smtp = await api('PUT', `/organizations/${org.orgId}/smtp-credentials`, {
      user: org.admin,
      body: { host: 'smtp.example.test', port: 587, username: 'u', password: 'p', fromAddress: 'kassa@example.test' },
    });
    expect(smtp.status).toBe(200);

    const sent = async (email: string) => (await recordedCalls('mailer')).filter((c) => c.path === '/send' && c.body?.to === email);

    const nl = `nl-${crypto.randomUUID()}@example.test`;
    expect((await api('POST', `/organizations/${org.orgId}/members`, { user: org.admin, body: { email: nl, role: 'cashier' } })).status).toBe(201);
    expect((await sent(nl)).map((c) => c.body.subject)).toEqual(['Uitnodiging voor Test org']);

    await api('PUT', localePath(org), { user: org.admin, body: { locale: 'fr' } });
    const fr = `fr-${crypto.randomUUID()}@example.test`;
    expect((await api('POST', `/organizations/${org.orgId}/members`, { user: org.admin, body: { email: fr, role: 'admin' } })).status).toBe(201);
    const [frMail] = await sent(fr);
    expect(frMail.body.subject).toBe('Invitation à rejoindre Test org');
    expect(frMail.body.text).toContain('en tant qu’administrateur.');
  });
});
