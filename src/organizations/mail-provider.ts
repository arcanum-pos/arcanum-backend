// Which outbound mail transport an org uses: 'smtp' (smtp-credentials.ts)
// or 'gmail_api' (gmail-api-credentials.ts). A separate, tiny table rather
// than a column on either credentials table, since "which transport is
// active" is a fact independent of what's configured for either one — an
// org can have both sets of credentials saved (e.g. mid-migration) with
// only one of them actually selected.
import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import { DEFAULT_ORG_ID } from './idp-resolution';
import type { MailProvider, MailProviderRow } from './types';

const VALID_PROVIDERS = new Set<MailProvider>(['smtp', 'gmail_api']);

export async function getMailProvider(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const provider = await resolveMailProvider(env, orgId);
  return json({ provider });
}

export async function setMailProvider(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  if (!body.provider || !VALID_PROVIDERS.has(body.provider as MailProvider)) {
    return json({ error: "provider must be 'smtp' or 'gmail_api'" }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO mail_provider (org_id, provider, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET provider = excluded.provider, updated_at = excluded.updated_at`
  )
    .bind(orgId, body.provider, new Date().toISOString())
    .run();

  return json({ provider: body.provider });
}

// This org's own choice if it's made one, otherwise the platform default
// org's, otherwise 'smtp' — so every org that predates this feature (no row
// for it or for 'default') keeps sending exactly as it did before.
export async function resolveMailProvider(env: Env, orgId: string): Promise<MailProvider> {
  const row = await env.DB.prepare('SELECT * FROM mail_provider WHERE org_id = ?').bind(orgId).first<MailProviderRow>();
  if (row) return row.provider;

  if (orgId !== DEFAULT_ORG_ID) {
    const defaultRow = await env.DB.prepare('SELECT * FROM mail_provider WHERE org_id = ?').bind(DEFAULT_ORG_ID).first<MailProviderRow>();
    if (defaultRow) return defaultRow.provider;
  }

  return 'smtp';
}
