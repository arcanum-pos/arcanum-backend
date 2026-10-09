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

// The installer's "Testmail sturen" (Geavanceerd → E-mail, MAIL.md): one
// mail to the signed-in instance admin's own (verified) address, through
// the installation's live MAIL_CONFIG — answered with the mailer's own
// verdict ({ ok } or { ok: false, code, error, detail }).
//   POST /organizations/mail-test
export async function testInstallationMail(request: Request, env: Env): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!caller.email || !isInstanceAdmin(env, caller.email, caller.emailVerified)) return json({ error: 'Forbidden' }, 403);
  let provider: ReturnType<typeof installationMailProvider>;
  try {
    provider = installationMailProvider(env);
  } catch (err) {
    return json({ ok: false, code: 'invalid_config', error: (err as Error).message }, 400);
  }
  if (!provider) return errorJson('mail_not_configured', 404);
  const answer = await sendMessageVerbose(env, provider, {
    to: caller.email,
    subject: 'Testmail van Arcanum',
    text: `Als je dit leest, werkt de e-mail van deze installatie (${provider.type}).`,
    html: `<p>Als je dit leest, werkt de e-mail van deze installatie (${provider.type}).</p>`,
    fromName: 'Arcanum',
  });
  return json({ ...answer.body, provider: provider.type, to: caller.email }, answer.status);
}
