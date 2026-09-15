// Outbound email lives in a separate Worker (questo-mail) — a raw-TCP SMTP
// client is a different kind of thing from an HTTP request handler, kept
// apart on purpose (same reasoning as questo-devicehub's own split). This
// module only ever asks it to send a fully-rendered email; content/business
// logic (what an invite email says) stays here in `worker`.
import type { Env } from './env';

interface SendEmailRequest {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  fromName?: string;
}

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

// Best-effort, matching devicehub-client.ts's broadcastPaymentEvent: a
// failure here must never fail whatever real action (e.g. creating an
// invite) triggered it — worst case, nobody gets emailed and the admin
// has to tell them out of band, exactly like before this existed.
export async function sendEmail(env: Env, request: SendEmailRequest): Promise<void> {
  try {
    const res = await callMailer(env, '/send', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      console.error('questo-mail returned an error', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    console.error('Kon questo-mail niet bereiken', err);
  }
}
