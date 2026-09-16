// Outbound email lives in a separate Worker (questo-mail) — a raw-TCP SMTP
// client is a different kind of thing from an HTTP request handler, kept
// apart on purpose (same reasoning as questo-devicehub's own split).
// questo-mail holds no SMTP secrets of its own — it's a pure transport:
// every send carries the full connection details for whichever org's
// config resolved (see organizations/smtp-credentials.ts), so each org can
// genuinely bring its own SMTP account rather than everything going out
// under one platform-wide identity.
import type { Env } from './env';
import type { ResolvedGmailApiCredentials } from './organizations/gmail-api-credentials';

// Defined here (the consumer) rather than in organizations/smtp-credentials.ts
// (the producer) so that file can import this type from here.
export interface ResolvedSmtpCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string | null;
}

interface MailMessage {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  fromName?: string;
}

// Tagged by provider so questo-mail knows which adapter to use — see
// organizations/mail.ts, the one place this gets constructed. SMTP and the
// Gmail API need entirely different credentials (a host/port/password vs a
// service account + impersonated user), so this can't be one flat shape.
export type SendEmailRequest =
  | (MailMessage & { provider: 'smtp'; credentials: ResolvedSmtpCredentials })
  | (MailMessage & { provider: 'gmail_api'; credentials: ResolvedGmailApiCredentials });

function internalKeyHeader(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.MAILER_INTERNAL_KEY}` };
}

async function callMailer(env: Env, path: string, init: RequestInit): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    ...internalKeyHeader(env),
    ...((init.headers as Record<string, string>) || {}),
  };

  if (env.MAILER_LOCAL_URL) {
    return fetch(`${env.MAILER_LOCAL_URL}${path}`, { ...init, headers });
  }
  return env.MAILER_SERVICE.fetch(`https://questo-mail${path}`, { ...init, headers });
}

// Throws on failure — deliberately, unlike questo-devicehub's own
// broadcastPaymentEvent. Whether a failed send should be best-effort
// (inviteMember: never fail invite creation just because email didn't go
// out) or surfaced (testSmtpCredentials: the whole point is telling the
// admin it didn't work) depends on the caller, not on this function —
// so each call site wraps this itself instead of the error being silently
// swallowed here for everyone.
export async function sendEmail(env: Env, request: SendEmailRequest): Promise<void> {
  const res = await callMailer(env, '/send', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`questo-mail returned ${res.status}: ${details}`);
  }
}
