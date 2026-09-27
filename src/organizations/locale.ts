// An organisation's default language: what its screens show until a user
// picks their own, and the language of the mails it sends (the invite —
// see email-templates/invite.ts). Stored as organizations.locale.
//
//   GET /organizations/:orgId/locale  (any member)  → { locale }
//   PUT /organizations/:orgId/locale  (admin)       { locale } → { locale }
import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';

export const LOCALES = ['nl', 'fr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'nl';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

// A stored/imported value as a Locale — anything unknown or missing is Dutch.
export function toLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function getOrgLocale(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin', 'cashier']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const row = await env.DB.prepare('SELECT locale FROM organizations WHERE id = ?').bind(orgId).first<{ locale: string }>();
  if (!row) return json({ error: 'Unknown organization' }, 404);
  return json({ locale: toLocale(row.locale) });
}

export async function setOrgLocale(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as { locale?: unknown };
  if (!isLocale(body.locale)) return json({ error: `locale must be one of ${LOCALES.join(', ')}` }, 400);

  const result = await env.DB.prepare('UPDATE organizations SET locale = ? WHERE id = ?').bind(body.locale, orgId).run();
  if ((result.meta.changes || 0) === 0) return json({ error: 'Unknown organization' }, 404);
  return json({ locale: body.locale });
}
