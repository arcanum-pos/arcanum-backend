// Content lives here (in `worker`, alongside the invite logic that
// triggers it), not in arcanum-mailer — that Worker is a pure transport
// ("send this to/subject/text/html"), it has no business knowing what an
// invite email says.
//
// No accept-link/token needed: reconcilePendingInvites (see
// organizations/members.ts) already activates a pending membership the
// moment its invited email logs in — the call to action is just "log in",
// not a one-time link.
import type { Locale } from '../organizations/locale';

export interface InviteEmailContent {
  subject: string;
  text: string;
  html: string;
}

// Per language: the role labels (as they read after "als" / "en tant que" /
// "as") and every sentence. The org's name, the role and the link are
// filled in by buildInviteEmail — `html` gets them escaped. French is
// Belgian French, formal ("vous"); English is British.
interface InviteCopy {
  roles: Record<string, string>;
  subject: (orgName: string) => string;
  invited: (orgName: string, roleLabel: string) => string;
  login: string;
  sameAddress: string;
}

const COPY: Record<Locale, InviteCopy> = {
  nl: {
    roles: { admin: 'beheerder', cashier: 'kassier' },
    subject: (org) => `Uitnodiging voor ${org}`,
    invited: (org, role) => `Je bent uitgenodigd om lid te worden van ${org} op Arcanum, als ${role}.`,
    login: 'Meld je aan om je uitnodiging te activeren',
    sameAddress: 'Gebruik hetzelfde e-mailadres waarop je deze uitnodiging ontvangen hebt.',
  },
  fr: {
    roles: { admin: 'administrateur', cashier: 'caissier' },
    subject: (org) => `Invitation à rejoindre ${org}`,
    // "en tant qu’administrateur" — elided before a vowel.
    invited: (org, role) => `Vous êtes invité(e) à rejoindre ${org} sur Arcanum, en tant ${/^[aeiouyéèh]/i.test(role) ? 'qu’' : 'que '}${role}.`,
    login: 'Connectez-vous pour activer votre invitation',
    sameAddress: 'Utilisez l’adresse e-mail à laquelle vous avez reçu cette invitation.',
  },
  en: {
    roles: { admin: 'an administrator', cashier: 'a cashier' },
    subject: (org) => `Invitation to join ${org}`,
    invited: (org, role) => `You have been invited to join ${org} on Arcanum, as ${role}.`,
    login: 'Log in to activate your invitation',
    sameAddress: 'Please use the email address at which you received this invitation.',
  },
};

// French puts a (non-breaking) space before a colon.
const COLON: Record<Locale, string> = { nl: ':', fr: '\u00a0:', en: ':' };

export function buildInviteEmail(params: { orgName: string; role: string; loginUrl: string; locale: Locale }): InviteEmailContent {
  const locale = params.locale;
  const copy = COPY[locale];
  const roleLabel = copy.roles[params.role] ?? params.role;

  const subject = copy.subject(params.orgName);

  const text = [
    copy.invited(params.orgName, roleLabel),
    '',
    `${copy.login}${COLON[locale]} ${params.loginUrl}`,
    '',
    copy.sameAddress,
  ].join('\n');

  const html = `
    <p>${copy.invited(`<strong>${escapeHtml(params.orgName)}</strong>`, escapeHtml(roleLabel))}</p>
    <p><a href="${escapeHtml(params.loginUrl)}">${copy.login}</a></p>
    <p>${copy.sameAddress}</p>
  `.trim();

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The installer's test mail (organizations/mail.ts): the same invitation —
// so a checker like mail-tester.com scores what members get — but marked
// as a test, so nobody mistakes it for a real one.
const TEST: Record<Locale, { subject: string; note: string }> = {
  nl: { subject: 'Testmail', note: 'Dit is een testmail van je Arcanum-installatie: zo ziet een uitnodiging eruit. Je hoeft er niets mee te doen.' },
  fr: { subject: 'E-mail de test', note: 'Ceci est un e-mail de test de votre installation Arcanum : voici à quoi ressemble une invitation. Vous n’avez rien à faire.' },
  en: { subject: 'Test mail', note: 'This is a test mail from your Arcanum installation: this is what an invitation looks like. There is nothing you need to do.' },
};

export function buildTestInviteEmail(params: { orgName: string; role: string; loginUrl: string; locale: Locale }): InviteEmailContent {
  const invite = buildInviteEmail(params);
  const test = TEST[params.locale];
  return {
    subject: `${test.subject} — ${invite.subject}`,
    text: `${test.note}\n\n${invite.text}`,
    html: `<p><em>${test.note}</em></p>\n${invite.html}`,
  };
}
