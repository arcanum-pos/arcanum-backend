// Outbound email lives in a separate Worker (arcanum-mailer) — a raw-TCP SMTP
// client is a different kind of thing from an HTTP request handler, kept
// apart on purpose (same reasoning as arcanum-devicehub's own split).
// arcanum-mailer holds no mail account of its own: every send names the
// service and carries its settings — here always the installation's
// MAIL_CONFIG (organizations/mail.ts, MAIL.md).
import type { Env } from './env';

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
  return env.ARCANUM_MAILER_SERVICE.fetch(`https://arcanum-mailer${path}`, { ...init, headers });
}

// The mailer's one contract (MAIL.md): a message, and the service to send
// it with — { type, …its settings }. sendMessage throws on failure —
// deliberately: whether that's best-effort (an invite is still made) or
// shown (the installer's test mail) is the caller's call.
export interface OutgoingMessage {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  fromName?: string;
  replyTo?: string;
}

// The mailer's answer as it is ({ ok, id? } or { ok: false, code, error,
// detail? }) — for the installer's test mail, which shows it.
export async function sendMessageVerbose(env: Env, provider: { type: string } & Record<string, unknown>, message: OutgoingMessage): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await callMailer(env, '/send', { method: 'POST', body: JSON.stringify({ message, provider }) });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body: body ?? { ok: false, code: 'unreachable', error: `arcanum-mailer returned ${res.status}` } };
}

export async function sendMessage(env: Env, provider: { type: string } & Record<string, unknown>, message: OutgoingMessage): Promise<void> {
  const res = await callMailer(env, '/send', { method: 'POST', body: JSON.stringify({ message, provider }) });
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`arcanum-mailer returned ${res.status}: ${details}`);
  }
}

