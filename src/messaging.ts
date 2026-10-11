// "Your order is ready" by SMS — MESSAGING.md. The installation's SMS
// account is one secret, MESSAGING_CONFIG, set by its installer (Geavanceerd
// → Sms); Twilio is the one provider so far, called straight from here (an
// HTTPS request — no Worker of its own, unlike mail's SMTP).
//
// A guest leaves a number on their order page (self-order.ts, /notify);
// when a station's ticket turns ready (prep-tickets.ts), notifyTicketReady
// sends one SMS for it:
//   - only for an order that's paid, or on a tab paid when leaving — an
//     unpaid self-order never costs anything;
//   - claimed on the ticket first (sms_status), so a double tap or a tap
//     back and forth never sends twice;
//   - within the installation's daily maximum (rolling 24 hours, sms_log);
//   - only to the countries the installation allows.
// The number is cleared once it's no longer needed (clearPhoneIfDone), and
// after a day at most (sweepPhones).
import { waitUntil } from 'cloudflare:workers';
import type { Env } from './env';
import { notifyTabsChanged } from './devicehub-client';

export interface SmsConfig {
  provider: 'twilio';
  accountSid: string;
  // An API key (SK…) and its secret instead of the account's auth token.
  apiKeySid?: string;
  authToken: string;
  // A phone number (+32…), an alphanumeric sender name, or a Messaging Service (MG…).
  sender: string;
  // Country codes numbers may have ("+32"); the first is the default for a national number (0470…).
  countries: string[];
  dailyCap: number;
}

export const DEFAULT_DAILY_CAP = 300;

// The installation's SMS account, or null when there's none (or it's unreadable).
export function smsConfig(env: Env): SmsConfig | null {
  if (!env.MESSAGING_CONFIG) return null;
  try {
    const c = JSON.parse(env.MESSAGING_CONFIG) as Partial<SmsConfig> & { countries?: unknown; dailyCap?: unknown };
    if (c.provider !== 'twilio' || !c.accountSid || !c.authToken || !c.sender) return null;
    const countries = (Array.isArray(c.countries) ? c.countries : typeof c.countries === 'string' ? String(c.countries).split(/[\s,;]+/) : [])
      .map((x) => String(x).trim())
      .filter((x) => /^\+\d{1,4}$/.test(x));
    const cap = Number(c.dailyCap);
    return {
      provider: 'twilio',
      accountSid: c.accountSid,
      apiKeySid: c.apiKeySid || undefined,
      authToken: c.authToken,
      sender: c.sender,
      countries: countries.length ? countries : ['+32'],
      dailyCap: Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_DAILY_CAP,
    };
  } catch {
    return null;
  }
}

// A number as typed ("0470 12 34 56", "+32 470/12.34.56", "0032470…") →
// E.164 in one of the allowed countries, or null.
export function normalizePhone(raw: unknown, countries: string[]): string | null {
  if (typeof raw !== 'string') return null;
  let n = raw.trim().replace(/[\s./()-]/g, '');
  if (n.startsWith('00')) n = `+${n.slice(2)}`;
  else if (/^0\d/.test(n)) n = `${countries[0] ?? '+32'}${n.slice(1)}`;
  if (!/^\+\d{8,15}$/.test(n)) return null;
  return countries.some((c) => n.startsWith(c)) ? n : null;
}

// What a page may show of it: the last two digits.
export const maskPhone = (phone: string) => `••• ${phone.slice(-2)}`;

// One SMS through Twilio's Messages API.
export async function sendSms(config: SmsConfig, to: string, body: string): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
  const form = new URLSearchParams({ To: to, Body: body });
  if (/^MG[0-9a-f]{32}$/i.test(config.sender)) form.set('MessagingServiceSid', config.sender);
  else form.set('From', config.sender);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${config.apiKeySid || config.accountSid}:${config.authToken}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok || !data.sid) return { ok: false, error: `${res.status}${data.code ? ` ${data.code}` : ''}: ${data.message ?? 'Twilio refused it'}`.slice(0, 300) };
    return { ok: true, ref: data.sid };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 300) };
  }
}

// The text: short, no characters outside the GSM alphabet of our own (one SMS, not two).
export function readyText(locale: string, o: { orgName: string; number: number; station: string }): string {
  const { orgName, number, station } = o;
  if (locale === 'fr') return `${orgName}: votre commande n°${number} est prête - ${station}.`;
  if (locale === 'en') return `${orgName}: your order #${number} is ready - ${station}.`;
  return `${orgName}: je bestelling #${number} is klaar - ${station}.`;
}

const DAY_MS = 24 * 3600_000;

// A station's ticket just turned ready: its SMS, in the background (the
// station's tap doesn't wait for Twilio).
export function notifyTicketReady(env: Env, orgId: string, ticketId: string): void {
  const config = smsConfig(env);
  if (!config) return;
  const work = sendForTicket(env, config, orgId, ticketId).catch((err) => console.error('Sms voor bon mislukt', err));
  try {
    waitUntil(work);
  } catch {
    // Outside a request context: it still runs, just unguarded.
  }
}

async function sendForTicket(env: Env, config: SmsConfig, orgId: string, ticketId: string): Promise<void> {
  // Claimed: only a ticket without an SMS yet, of a tab with a number that's
  // paid (or paid when leaving).
  const claimed = await env.DB.prepare(
    `UPDATE prep_tickets SET sms_status = 'sending'
     WHERE id = ? AND org_id = ? AND sms_status IS NULL
       AND EXISTS (SELECT 1 FROM tabs t WHERE t.id = prep_tickets.tab_id AND t.notify_phone IS NOT NULL AND (t.status = 'closed' OR t.pay_later = 1))
     RETURNING tab_id, station_name`
  )
    .bind(ticketId, orgId)
    .first<{ tab_id: string; station_name: string }>();
  if (!claimed) return;

  const tab = await env.DB.prepare(
    `SELECT t.notify_phone, COALESCE(t.event_number, t.number) AS number, o.name AS org_name, o.locale
     FROM tabs t JOIN organizations o ON o.id = t.org_id WHERE t.id = ?`
  )
    .bind(claimed.tab_id)
    .first<{ notify_phone: string | null; number: number; org_name: string; locale: string | null }>();
  const now = new Date();
  const logId = crypto.randomUUID();
  // Within the installation's daily maximum: the attempt is logged only if
  // there's room (one statement, so two stations at once can't both slip in).
  const room = await env.DB.prepare(
    `INSERT INTO sms_log (id, org_id, ticket_id, status, created_at)
     SELECT ?, ?, ?, 'sending', ? WHERE (SELECT COUNT(*) FROM sms_log WHERE created_at >= ? AND status <> 'capped') < ?`
  )
    .bind(logId, orgId, ticketId, now.toISOString(), new Date(now.getTime() - DAY_MS).toISOString(), config.dailyCap)
    .run();
  if (!room.meta.changes || !tab?.notify_phone) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE prep_tickets SET sms_status = ? WHERE id = ?`).bind(tab?.notify_phone ? 'capped' : 'failed', ticketId),
      env.DB.prepare(`INSERT INTO sms_log (id, org_id, ticket_id, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(
        crypto.randomUUID(),
        orgId,
        ticketId,
        tab?.notify_phone ? 'capped' : 'failed',
        tab?.notify_phone ? `daily maximum of ${config.dailyCap} reached` : 'no number',
        now.toISOString()
      ),
    ]);
    notifyTabsChanged(env, orgId, [claimed.tab_id]);
    return;
  }

  const sent = await sendSms(config, tab.notify_phone, readyText(tab.locale || 'nl', { orgName: tab.org_name, number: tab.number, station: claimed.station_name }));
  await env.DB.batch([
    env.DB.prepare(`UPDATE prep_tickets SET sms_status = ? WHERE id = ?`).bind(sent.ok ? 'sent' : 'failed', ticketId),
    env.DB.prepare(`UPDATE sms_log SET status = ?, error = ?, provider_ref = ? WHERE id = ?`).bind(sent.ok ? 'sent' : 'failed', sent.ok ? null : sent.error, sent.ok ? sent.ref : null, logId),
    clearPhoneIfDone(env, claimed.tab_id),
  ]);
  notifyTabsChanged(env, orgId, [claimed.tab_id]);
}

// The number goes once nothing more can need it: the tab isn't open any
// more (no more rounds) and no ticket still waits to be made ready.
export function clearPhoneIfDone(env: Env, tabId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE tabs SET notify_phone = NULL WHERE id = ? AND notify_phone IS NOT NULL AND status <> 'open'
       AND NOT EXISTS (SELECT 1 FROM prep_tickets p WHERE p.tab_id = tabs.id AND p.sms_status IS NULL AND p.status IN ('ordered', 'in_progress'))`
  ).bind(tabId);
}

// Never kept longer than a day, nor on a cancelled tab, nor once nothing can
// need it any more (run whenever a station screen looks — no timer needed).
export function sweepPhones(env: Env, orgId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE tabs SET notify_phone = NULL WHERE org_id = ? AND notify_phone IS NOT NULL AND (
       status = 'cancelled' OR opened_at < ?
       OR (status = 'closed' AND NOT EXISTS (SELECT 1 FROM prep_tickets p WHERE p.tab_id = tabs.id AND p.sms_status IS NULL AND p.status IN ('ordered', 'in_progress'))))`
  ).bind(orgId, new Date(Date.now() - DAY_MS).toISOString());
}
