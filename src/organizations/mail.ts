// Ties the two mail transports together: resolves whichever one an org has
// selected (mail-provider.ts) into the right shape of credentials, and is
// the one place that actually calls questo-mail. inviteMember (members.ts)
// and testMailConfiguration (below) both go through here rather than
// picking a transport themselves.
import type { Env } from '../env';
import { json } from '../http';
import { sendEmail, type SendEmailRequest } from '../mailer-client';
import { extractCaller, requireOrgRole } from './auth';
import { resolveMailProvider } from './mail-provider';
import { resolveSmtpCredentialsForSend } from './smtp-credentials';
import { resolveGmailApiCredentialsForSend } from './gmail-api-credentials';

interface MailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  fromName?: string;
}

// Resolves the org's active transport into a ready-to-send request, or
// null if that transport isn't actually configured (this org has nothing
// of its own and neither does the 'default' org).
async function buildSendRequest(env: Env, orgId: string, message: MailMessage): Promise<SendEmailRequest | null> {
  const provider = await resolveMailProvider(env, orgId);

  if (provider === 'gmail_api') {
    const credentials = await resolveGmailApiCredentialsForSend(env, orgId);
    if (!credentials) return null;
    return { ...message, provider: 'gmail_api', credentials };
  }

  const credentials = await resolveSmtpCredentialsForSend(env, orgId);
  if (!credentials) return null;
  return { ...message, provider: 'smtp', credentials };
}

// Best-effort send for an org's configured transport (invites, and anything
// else that must never fail its own action just because mail didn't go
// out) — throws on failure, same as sendEmail itself; the caller decides
// whether that's fatal or just logged.
export async function sendOrgEmail(env: Env, orgId: string, message: MailMessage): Promise<void> {
  const request = await buildSendRequest(env, orgId, message);
  if (!request) throw new Error('No mail transport configured for this organization (and no platform default either)');
  await sendEmail(env, request);
}

// Admin action: sends a real test email to the admin's own address, using
// whichever transport currently resolves for this org (their own if set,
// else the platform default's) — the way to actually verify a saved
// config works, since neither SMTP passwords nor a service account key can
// be validated synchronously at save time.
export async function testMailConfiguration(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!caller.email) return json({ error: 'No email address on your session to send a test to' }, 400);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const provider = await resolveMailProvider(env, orgId);
  const sendRequest = await buildSendRequest(env, orgId, {
    to: caller.email,
    subject: 'Testmail van Questo',
    text: 'Als je dit leest, werkt de e-mailconfiguratie voor deze organisatie.',
    html: '<p>Als je dit leest, werkt de e-mailconfiguratie voor deze organisatie.</p>',
  });
  if (!sendRequest) {
    return json({ error: 'Geen e-mailconfiguratie gevonden (en ook geen platform-standaard)', provider }, 404);
  }

  try {
    await sendEmail(env, sendRequest);
    return json({ ok: true, provider });
  } catch (err) {
    return json({ error: 'Verzenden mislukt', details: (err as Error).message, provider }, 502);
  }
}
