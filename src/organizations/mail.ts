// The installation's mail (MAIL.md): one account for all its organisations,
// MAIL_CONFIG, set by the installer (Geavanceerd → E-mail). The one place
// that calls arcanum-mailer: invites (members.ts) and the installer's test
// mail go through here. The per-organisation settings and the `default`
// org's copy of DEFAULT_SMTP_* are gone (phase 4); their tables stay in the
// database, unread.
import type { Env } from '../env';
import { json } from '../http';
import { errorJson } from '../errors';
import { sendMessage, sendMessageVerbose } from '../mailer-client';
import { extractCaller } from './auth';
import { isInstanceAdmin } from './instance-admins';
import { buildTestInviteEmail } from '../email-templates/invite';
import { toLocale } from './locale';

interface MailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  fromName?: string;
}

// The installation's mail account (MAIL_CONFIG), as the mailer's provider
// { type, …settings }; null when the installer hasn't set one.
// Either form: flat {"provider":"brevo","apiKey",…} or {"provider","credentials":{…}}.
export function installationMailProvider(env: Env): ({ type: string } & Record<string, unknown>) | null {
  if (!env.MAIL_CONFIG) return null;
  const config = JSON.parse(env.MAIL_CONFIG) as { provider?: unknown; credentials?: unknown } & Record<string, unknown>;
  if (typeof config.provider !== 'string' || !config.provider) throw new Error('MAIL_CONFIG must name its "provider"');
  const { provider, credentials, ...settings } = config;
  return { ...(credentials && typeof credentials === 'object' ? (credentials as Record<string, unknown>) : settings), type: provider };
}

// An organisation's mail (invites, and anything else that must never fail
// its own action just because mail didn't go out) — throws when it didn't
// go (no mail set up, or the service refused); the caller decides whether
// that's fatal or just reported. The sender's name: the organisation's.
export async function sendOrgEmail(env: Env, orgId: string, message: MailMessage): Promise<void> {
  const provider = installationMailProvider(env);
  if (!provider) throw new Error('This installation has no mail set up (MAIL_CONFIG)');
  const fromName = message.fromName ?? (await env.DB.prepare('SELECT name FROM organizations WHERE id = ?').bind(orgId).first<{ name: string }>())?.name;
  await sendMessage(env, provider, { ...message, ...(fromName ? { fromName } : {}) });
}

// The installer's "Testmail sturen" (Geavanceerd → E-mail, MAIL.md): a real
// invitation, marked as a test — what members get, so a checker like
// mail-tester.com scores what matters — through the installation's live MAIL_CONFIG, answered with
// the mailer's own verdict ({ ok } or { ok: false, code, error, detail }).
// To the signed-in instance admin's own (verified) address, or the one
// given (a checker's address).
//   POST /organizations/mail-test  { to? }
// At most TEST_MAILS_PER_HOUR per admin — counted in this isolate's memory:
// best effort, enough to keep the field from being a free mail cannon.
const TEST_MAILS_PER_HOUR = 10;
const testMailsSent = new Map<string, number[]>();

function overTestLimit(who: string, now = Date.now()): boolean {
  const recent = (testMailsSent.get(who) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= TEST_MAILS_PER_HOUR) return true;
  testMailsSent.set(who, [...recent, now]);
  return false;
}

const EMAIL = /^[^@\s]+@[^@\s]+$/;

export async function testInstallationMail(request: Request, env: Env): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!caller.email || !isInstanceAdmin(env, caller.email, caller.emailVerified)) return json({ error: 'Forbidden' }, 403);
  const body = (await request.json().catch(() => ({}))) as { to?: unknown };
  const to = typeof body.to === 'string' && body.to.trim() ? body.to.trim() : caller.email;
  if (!EMAIL.test(to)) return errorJson('invalid_email', 400);
  let provider: ReturnType<typeof installationMailProvider>;
  try {
    provider = installationMailProvider(env);
  } catch (err) {
    return json({ ok: false, code: 'invalid_config', error: (err as Error).message }, 400);
  }
  if (!provider) return errorJson('mail_not_configured', 404);
  if (overTestLimit(caller.email.toLowerCase())) return errorJson('too_many_test_mails', 429);
  // An invitation from this installation's first organisation, in its language.
  const org = await env.DB.prepare("SELECT name, locale FROM organizations WHERE id <> 'default' ORDER BY created_at LIMIT 1").first<{ name: string; locale: string }>();
  const orgName = org?.name ?? 'Arcanum';
  const content = buildTestInviteEmail({ orgName, role: 'cashier', loginUrl: `${env.PUBLIC_BASE_URL}/login`, locale: toLocale(org?.locale) });
  const answer = await sendMessageVerbose(env, provider, { to, fromName: orgName, ...content });
  return json({ ...answer.body, provider: provider.type, to }, answer.status);
}
