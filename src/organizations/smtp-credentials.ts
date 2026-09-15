// Lets an organization use its own outbound SMTP account instead of the
// platform default — same shape as identity-providers.ts: an org's own
// config if it has one, otherwise the 'default' org's, encrypted with each
// org's own DEK. Unlike an OIDC issuer, there's no cheap "discovery"
// request to validate SMTP credentials against at save time — that's what
// the explicit test-send action (testSmtpCredentials) is for, not a gate
// on saving.
import type { Env } from '../env';
import { json } from '../http';
import { extractCaller, requireOrgRole } from './auth';
import { getOrgDataKey } from './organizations';
import { sendEmail, type ResolvedSmtpCredentials } from '../mailer-client';
import { encryptWithKey, decryptWithKey } from './crypto';
import { ensureDefaultOrganizationRow, DEFAULT_ORG_ID } from './idp-resolution';
import type { SmtpCredentialRow } from './types';

// Never returns the decrypted password — only whether one is set.
function rowToPublicSmtp(row: SmtpCredentialRow | null) {
  if (!row) {
    return { host: null, port: null, username: null, fromAddress: null, fromName: null, hasPassword: false, updatedAt: null };
  }
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    fromAddress: row.from_address,
    fromName: row.from_name,
    hasPassword: Boolean(row.password_ciphertext),
    updatedAt: row.updated_at,
  };
}

export async function getSmtpCredentials(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const row = await env.DB.prepare('SELECT * FROM smtp_credentials WHERE org_id = ?').bind(orgId).first<SmtpCredentialRow>();
  return json(rowToPublicSmtp(row));
}

export async function setSmtpCredentials(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const body = (await request.json().catch(() => ({}))) as {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    fromAddress?: string;
    fromName?: string;
  };

  const dek = await getOrgDataKey(env, orgId);
  if (!dek) return json({ error: 'Unknown organization' }, 404);

  const existing = await env.DB.prepare('SELECT * FROM smtp_credentials WHERE org_id = ?').bind(orgId).first<SmtpCredentialRow>();

  let passwordCiphertext: string | null = null;
  let passwordIv: string | null = null;
  // Only re-encrypt the password if a new one was actually sent — an admin
  // updating just the host/port shouldn't have to resupply it.
  if (body.password) {
    const encrypted = await encryptWithKey(body.password, dek);
    passwordCiphertext = encrypted.ciphertext;
    passwordIv = encrypted.iv;
  }

  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO smtp_credentials (org_id, host, port, username, password_ciphertext, password_iv, from_address, from_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET
       host = excluded.host,
       port = excluded.port,
       username = excluded.username,
       password_ciphertext = COALESCE(excluded.password_ciphertext, smtp_credentials.password_ciphertext),
       password_iv = COALESCE(excluded.password_iv, smtp_credentials.password_iv),
       from_address = excluded.from_address,
       from_name = excluded.from_name,
       updated_at = excluded.updated_at`
  )
    .bind(
      orgId,
      body.host ?? existing?.host ?? null,
      body.port ?? existing?.port ?? null,
      body.username ?? existing?.username ?? null,
      passwordCiphertext,
      passwordIv,
      body.fromAddress ?? existing?.from_address ?? null,
      body.fromName ?? existing?.from_name ?? null,
      now
    )
    .run();

  const row = await env.DB.prepare('SELECT * FROM smtp_credentials WHERE org_id = ?').bind(orgId).first<SmtpCredentialRow>();
  return json(rowToPublicSmtp(row));
}

// Idempotent: seeds the platform-default SMTP account from DEFAULT_SMTP_*
// secrets the first time it's needed. A cheap existence check makes every
// call after the first a no-op.
export async function ensureDefaultSmtpCredentials(env: Env): Promise<void> {
  const alreadySeeded = await env.DB.prepare('SELECT org_id FROM smtp_credentials WHERE org_id = ?').bind(DEFAULT_ORG_ID).first();
  if (alreadySeeded) return;

  if (!env.DEFAULT_SMTP_HOST || !env.DEFAULT_SMTP_USER || !env.DEFAULT_SMTP_PASS || !env.DEFAULT_SMTP_FROM_ADDRESS) {
    throw new Error('Default SMTP account is not configured (DEFAULT_SMTP_* secrets missing)');
  }

  await ensureDefaultOrganizationRow(env);

  const actualDek = await getOrgDataKey(env, DEFAULT_ORG_ID);
  if (!actualDek) throw new Error('Failed to seed default organization');

  const encryptedPassword = await encryptWithKey(env.DEFAULT_SMTP_PASS, actualDek);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO smtp_credentials (org_id, host, port, username, password_ciphertext, password_iv, from_address, from_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO NOTHING`
  )
    .bind(
      DEFAULT_ORG_ID,
      env.DEFAULT_SMTP_HOST,
      Number(env.DEFAULT_SMTP_PORT) || 587,
      env.DEFAULT_SMTP_USER,
      encryptedPassword.ciphertext,
      encryptedPassword.iv,
      env.DEFAULT_SMTP_FROM_ADDRESS,
      env.DEFAULT_SMTP_FROM_NAME || null,
      now
    )
    .run();
}

// Resolves what worker's mailer-client needs to actually send for orgId —
// that org's own SMTP account if it has one, otherwise the platform
// default's. The one place the plaintext password leaves the DB. Called
// directly (a plain function call, not an HTTP route): unlike the
// identity-provider resolution, the caller here (worker itself, via
// inviteMember/testSmtpCredentials) already owns this D1 database, so
// there's no cross-Worker hop to gate.
export async function resolveSmtpCredentialsForSend(env: Env, orgId: string): Promise<ResolvedSmtpCredentials | null> {
  await ensureDefaultSmtpCredentials(env);

  let row = await env.DB.prepare('SELECT * FROM smtp_credentials WHERE org_id = ?').bind(orgId).first<SmtpCredentialRow>();
  let effectiveOrgId = orgId;
  if (!row?.host) {
    row = await env.DB.prepare('SELECT * FROM smtp_credentials WHERE org_id = ?').bind(DEFAULT_ORG_ID).first<SmtpCredentialRow>();
    effectiveOrgId = DEFAULT_ORG_ID;
  }

  if (!row || !row.host || !row.port || !row.username || !row.password_ciphertext || !row.password_iv || !row.from_address) {
    return null;
  }

  const dek = await getOrgDataKey(env, effectiveOrgId);
  if (!dek) return null;

  const password = await decryptWithKey({ ciphertext: row.password_ciphertext, iv: row.password_iv }, dek);

  return {
    host: row.host,
    port: row.port,
    username: row.username,
    password,
    fromAddress: row.from_address,
    fromName: row.from_name,
  };
}

// Admin action: sends a real test email to the admin's own address, using
// whatever SMTP config currently resolves for this org (their own if set,
// else the platform default's) — the way to actually verify a saved
// config works, since there's no cheap way to validate SMTP credentials
// synchronously at save time the way OIDC discovery lets identity-provider
// config be validated.
export async function testSmtpCredentials(request: Request, env: Env, orgId: string): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!caller.email) return json({ error: 'No email address on your session to send a test to' }, 400);

  const membership = await requireOrgRole(env, orgId, caller, ['admin']);
  if (!membership) return json({ error: 'Forbidden' }, 403);

  const credentials = await resolveSmtpCredentialsForSend(env, orgId);
  if (!credentials) return json({ error: 'No SMTP account configured (and no platform default either)' }, 404);

  try {
    await sendEmail(env, {
      to: caller.email,
      subject: 'Testmail van Questo',
      text: 'Als je dit leest, werkt de SMTP-configuratie voor deze organisatie.',
      html: '<p>Als je dit leest, werkt de SMTP-configuratie voor deze organisatie.</p>',
      credentials,
    });
    return json({ ok: true });
  } catch (err) {
    return json({ error: 'Verzenden mislukt', details: (err as Error).message }, 502);
  }
}
