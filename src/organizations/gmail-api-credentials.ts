// Lets an organization send outbound mail via the Gmail API (a domain-wide-
// delegated service account impersonating a Workspace user) instead of
// SMTP — same shape as smtp-credentials.ts: an org's own config if it has
// one, otherwise the 'default' org's, encrypted with each org's own DEK.
// Unlike SMTP, this needs no DNS/SPF/DKIM changes at all: it's Google's own
// already-authorized first-party sending path for the domain (see the
// design-doc discussion this came out of — SMTP-from-Workers ran into
// Google's IP-reputation-based rejection of raw SMTP AUTH from cloud
// egress ranges; the Gmail API sidesteps that entirely by never opening a
// raw SMTP connection).
import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import { getOrgDataKey } from './organizations';
import { encryptWithKey, decryptWithKey } from './crypto';
import { DEFAULT_ORG_ID } from './idp-resolution';
import type { GmailApiCredentialRow } from './types';

// Never returns the decrypted private key — only whether one is set.
function rowToPublicGmailApi(row: GmailApiCredentialRow | null) {
  if (!row) {
    return { clientEmail: null, impersonatedUser: null, fromName: null, hasPrivateKey: false, updatedAt: null };
  }
  return {
    clientEmail: row.client_email,
    impersonatedUser: row.impersonated_user,
    fromName: row.from_name,
    hasPrivateKey: Boolean(row.private_key_ciphertext),
    updatedAt: row.updated_at,
  };
}

export async function getGmailApiCredentials(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const row = await env.DB.prepare('SELECT * FROM gmail_api_credentials WHERE org_id = ?').bind(orgId).first<GmailApiCredentialRow>();
  return json(rowToPublicGmailApi(row));
}

export async function setGmailApiCredentials(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as {
    clientEmail?: string;
    privateKey?: string;
    impersonatedUser?: string;
    fromName?: string;
  };

  const dek = await getOrgDataKey(env, orgId);
  if (!dek) return json({ error: 'Unknown organization' }, 404);

  const existing = await env.DB.prepare('SELECT * FROM gmail_api_credentials WHERE org_id = ?').bind(orgId).first<GmailApiCredentialRow>();

  let privateKeyCiphertext: string | null = null;
  let privateKeyIv: string | null = null;
  // Only re-encrypt if a new key was actually sent — an admin updating just
  // the impersonated user shouldn't have to re-upload the service account.
  if (body.privateKey) {
    const encrypted = await encryptWithKey(body.privateKey, dek);
    privateKeyCiphertext = encrypted.ciphertext;
    privateKeyIv = encrypted.iv;
  }

  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO gmail_api_credentials (org_id, client_email, private_key_ciphertext, private_key_iv, impersonated_user, from_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET
       client_email = excluded.client_email,
       private_key_ciphertext = COALESCE(excluded.private_key_ciphertext, gmail_api_credentials.private_key_ciphertext),
       private_key_iv = COALESCE(excluded.private_key_iv, gmail_api_credentials.private_key_iv),
       impersonated_user = excluded.impersonated_user,
       from_name = excluded.from_name,
       updated_at = excluded.updated_at`
  )
    .bind(
      orgId,
      body.clientEmail ?? existing?.client_email ?? null,
      privateKeyCiphertext,
      privateKeyIv,
      body.impersonatedUser ?? existing?.impersonated_user ?? null,
      body.fromName ?? existing?.from_name ?? null,
      now
    )
    .run();

  const row = await env.DB.prepare('SELECT * FROM gmail_api_credentials WHERE org_id = ?').bind(orgId).first<GmailApiCredentialRow>();
  return json(rowToPublicGmailApi(row));
}

type CompleteGmailApiCredentialRow = GmailApiCredentialRow & {
  client_email: string;
  private_key_ciphertext: string;
  private_key_iv: string;
  impersonated_user: string;
};

function isCompleteRow(row: GmailApiCredentialRow | null | undefined): row is CompleteGmailApiCredentialRow {
  return Boolean(row?.client_email && row?.private_key_ciphertext && row?.private_key_iv && row?.impersonated_user);
}

export interface ResolvedGmailApiCredentials {
  clientEmail: string;
  privateKey: string;
  impersonatedUser: string;
  fromName: string | null;
}

// Resolves what worker's mailer-client needs to actually send for orgId —
// that org's own service account if it has one, otherwise the platform
// default's. The one place the plaintext private key leaves the DB.
export async function resolveGmailApiCredentialsForSend(env: Env, orgId: string): Promise<ResolvedGmailApiCredentials | null> {
  let row = await env.DB.prepare('SELECT * FROM gmail_api_credentials WHERE org_id = ?').bind(orgId).first<GmailApiCredentialRow>();
  let effectiveOrgId = orgId;

  if (!isCompleteRow(row)) {
    row = await env.DB.prepare('SELECT * FROM gmail_api_credentials WHERE org_id = ?').bind(DEFAULT_ORG_ID).first<GmailApiCredentialRow>();
    effectiveOrgId = DEFAULT_ORG_ID;
  }

  if (!isCompleteRow(row)) return null;

  const dek = await getOrgDataKey(env, effectiveOrgId);
  if (!dek) return null;

  const privateKey = await decryptWithKey({ ciphertext: row.private_key_ciphertext, iv: row.private_key_iv }, dek);

  return {
    clientEmail: row.client_email,
    privateKey,
    impersonatedUser: row.impersonated_user,
    fromName: row.from_name,
  };
}
