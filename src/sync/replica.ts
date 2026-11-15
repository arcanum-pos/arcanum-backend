// Offline sync, the cloud's side (OFFLINE.md): a backup of a box's org.
//
//   POST /organizations/backups   (whoever may create an org here) → a link code, shown once
//   POST /sync/hello              (the box, Authorization: Bearer <key>) → makes or finds the replica
//   POST /sync/batch              (the box, Authorization: Bearer <key>) → applies changes
//
// The /sync routes come in through arcanum-bff's /sync/* without a session:
// the sync key alone says which org, never the request body.
//
// A link code holds this installation's address and a random key. The box's
// first call with it creates the replica org with the box's own org id (so
// URLs and kiosks keep working after a promotion), its maker as admin; from
// then on the key is that org's sync key. A replica is read-only for people:
// guard triggers on every synced table (spec.ts) refuse their writes; a batch
// marks its own transaction in sync_applying to get through.
import type { Env } from '../env';
import { json } from '../http';
import { errorJson } from '../errors';
import { extractCaller } from '../organizations/auth';
import { encryptWithKey, generateDataKey, unwrapDataKey, wrapDataKey } from '../organizations/crypto';
import { orgCreationRefusal } from '../organizations/org-creation';
import { toLocale } from '../organizations/locale';
import { SYNC_PROTOCOL, SYNC_REFS, SYNC_SCHEMA, SYNC_TABLE, SYNC_TABLES, type SyncTable } from './spec';

const INVITE_DAYS = 7;
// Statements a batch may need besides its tables' own (the flag in and out,
// the link's status), and the cap on the tables' own: within the Workers
// Free plan's 50 queries per invocation together with the two reads before.
const FIXED_STATEMENTS = 3;
export const MAX_TABLE_STATEMENTS = 40;
// A batch's body; D1 takes a bound parameter up to 2 MB, one table's rows travel as one.
export const MAX_BATCH_BYTES = 1_500_000;

// --- The link code ---

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CODE_PREFIX = 'arcanum-backup:';

export function makeLinkCode(url: string, key: string): string {
  return CODE_PREFIX + b64url(new TextEncoder().encode(JSON.stringify({ url, key })));
}

export function parseLinkCode(code: string): { url: string; key: string } | null {
  const text = code.trim();
  if (!text.startsWith(CODE_PREFIX)) return null;
  try {
    const b64 = text.slice(CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    if (typeof parsed?.url !== 'string' || typeof parsed?.key !== 'string' || !/^https?:\/\//.test(parsed.url) || parsed.key.length < 32) return null;
    return { url: parsed.url.replace(/\/+$/, ''), key: parsed.key };
  } catch {
    return null;
  }
}

async function createInvite(request: Request, env: Env): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const refusal = await orgCreationRefusal(env, caller);
  if (refusal) return errorJson(refusal, 403);

  const key = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sync_invites (key_hash, created_by_sub, created_by_issuer, created_by_email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(await sha256Hex(key), caller.sub, caller.issuer, caller.email, now.toISOString(), expiresAt)
    .run();
  return json({ code: makeLinkCode(env.PUBLIC_BASE_URL, key), expiresAt }, 201);
}

// --- The box's calls ---

function bearer(request: Request): string | null {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

interface ReplicaLink {
  org_id: string;
  last_seq: number;
  dek_ciphertext: string;
  dek_iv: string;
}

async function replicaFor(env: Env, keyHash: string): Promise<ReplicaLink | null> {
  return env.DB.prepare(
    `SELECT l.org_id, l.last_seq, o.dek_ciphertext, o.dek_iv FROM sync_links l JOIN organizations o ON o.id = l.org_id
     WHERE l.key_hash = ? AND l.role = 'replica'`
  )
    .bind(keyHash)
    .first<ReplicaLink>();
}

function versionMismatch(body: { protocol?: unknown; schema?: unknown }): Response | null {
  if (body.protocol === SYNC_PROTOCOL && body.schema === SYNC_SCHEMA) return null;
  return json({ error: 'The box and this installation sync different data: update both to the same release', code: 'sync_version_mismatch', protocol: SYNC_PROTOCOL, schema: SYNC_SCHEMA }, 409);
}

const syncError = (code: string, error: string, status: number, extra: Record<string, unknown> = {}) => json({ error, code, ...extra }, status);

async function hello(request: Request, env: Env): Promise<Response> {
  const key = bearer(request);
  if (!key) return json({ error: 'Unauthorized' }, 401);
  const body = (await request.json().catch(() => ({}))) as { orgId?: unknown; name?: unknown; locale?: unknown; protocol?: unknown; schema?: unknown };
  const mismatch = versionMismatch(body);
  if (mismatch) return mismatch;
  const keyHash = await sha256Hex(key);

  const existing = await replicaFor(env, keyHash);
  if (existing) {
    if (existing.org_id !== body.orgId) return syncError('sync_wrong_org', 'This key belongs to another organisation', 409);
    return json({ orgId: existing.org_id, lastSeq: existing.last_seq, protocol: SYNC_PROTOCOL, schema: SYNC_SCHEMA });
  }

  const orgId = typeof body.orgId === 'string' ? body.orgId : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(orgId) || !name) return json({ error: 'orgId and name are required' }, 400);
  const now = new Date().toISOString();
  const invite = await env.DB.prepare('SELECT * FROM sync_invites WHERE key_hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(keyHash, now)
    .first<{ created_by_sub: string; created_by_issuer: string; created_by_email: string }>();
  if (!invite) return json({ error: 'Unauthorized' }, 401);
  if (await env.DB.prepare('SELECT 1 FROM organizations WHERE id = ?').bind(orgId).first()) {
    return syncError('sync_org_exists', 'An organisation with this id already exists on this installation', 409);
  }

  const wrapped = await wrapDataKey(generateDataKey(), env.ENCRYPTION_KEY);
  // All or nothing, and only once per invite: every statement after the
  // first depends on the invite having been taken by this call.
  const taken = 'EXISTS (SELECT 1 FROM sync_invites WHERE key_hash = ? AND org_id = ?)';
  await env.DB.batch([
    env.DB.prepare('UPDATE sync_invites SET used_at = ?, org_id = ? WHERE key_hash = ? AND used_at IS NULL').bind(now, orgId, keyHash),
    env.DB.prepare(
      `INSERT INTO organizations (id, name, locale, dek_ciphertext, dek_iv, created_at, created_by_sub) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${taken}`
    ).bind(orgId, name, toLocale(body.locale), wrapped.ciphertext, wrapped.iv, now, invite.created_by_sub, keyHash, orgId),
    env.DB.prepare(
      `INSERT INTO memberships (id, org_id, user_sub, issuer, invited_email, role, status, invited_at, accepted_at) SELECT ?, ?, ?, ?, ?, 'admin', 'active', ?, ? WHERE ${taken}`
    ).bind(crypto.randomUUID(), orgId, invite.created_by_sub, invite.created_by_issuer, invite.created_by_email, now, now, keyHash, orgId),
    env.DB.prepare(`INSERT INTO sync_links (org_id, role, key_hash, created_at) SELECT ?, 'replica', ?, ? WHERE ${taken}`).bind(orgId, keyHash, now, keyHash, orgId),
  ]);
  const made = await replicaFor(env, keyHash);
  if (!made) return json({ error: 'Unauthorized' }, 401);
  return json({ orgId: made.org_id, lastSeq: made.last_seq, protocol: SYNC_PROTOCOL, schema: SYNC_SCHEMA }, 201);
}

// --- Batches ---

export interface SyncBatchTable {
  table: string;
  // Rows as the box has them now (its synced columns); a secret table's rows
  // carry `config` decrypted instead of its ciphertext.
  upserts?: Record<string, unknown>[];
  // Keys (as in sync_outbox.row_key) of rows the box no longer has.
  deletes?: unknown[][];
}

export interface SyncBatch {
  protocol: number;
  schema: string;
  // The last outbox sequence this batch covers (0 for a heartbeat before anything).
  toSeq: number;
  tables: SyncBatchTable[];
}

// How many of the cloud's statements a batch's tables take: the box keeps
// it at or under MAX_TABLE_STATEMENTS.
export function tableStatements(tables: SyncBatchTable[]): number {
  return tables.reduce((n, t) => n + (t.upserts?.length ? 1 : 0) + (t.deletes?.length ? 1 : 0), 0);
}

const keyMatch = (t: SyncTable, param: string) =>
  t.key.length === 0
    ? ''
    : t.key.length === 1
      ? ` AND ${t.key[0]} IN (SELECT json_extract(value, '$[0]') FROM json_each(${param}))`
      : ` AND (${t.key.join(', ')}) IN (SELECT ${t.key.map((_, i) => `json_extract(value, '$[${i}]')`).join(', ')} FROM json_each(${param}))`;

function deleteStatement(env: Env, t: SyncTable, orgId: string, keys: unknown[][]): D1PreparedStatement | null {
  if (t.table === 'organizations') return null; // the org itself goes only with a promotion's cleanup
  const statement = env.DB.prepare(`DELETE FROM ${t.table} WHERE ${t.orgColumn} = ?1${keyMatch(t, '?2')}`);
  return t.key.length ? statement.bind(orgId, JSON.stringify(keys)) : statement.bind(orgId);
}

function upsertStatement(env: Env, t: SyncTable, orgId: string, rows: Record<string, unknown>[]): D1PreparedStatement {
  const columns = t.columns;
  const payload = JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))));
  if (t.table === 'organizations') {
    // One row, the org's own: its settings, never another org's.
    const set = columns.map((c) => `${c} = json_extract(?2, '$[0].${c}')`).join(', ');
    return env.DB.prepare(`UPDATE organizations SET ${set} WHERE id = ?1`).bind(orgId, payload);
  }
  const all = [t.orgColumn, ...columns];
  const select = [`?1`, ...columns.map((c) => `json_extract(value, '$.${c}')`)].join(', ');
  const conflict = t.key.length === 0 ? [t.orgColumn] : t.key.includes('id') ? ['id'] : t.table === 'charge_lines' ? t.key : [t.orgColumn, ...t.key];
  const update = columns.filter((c) => !conflict.includes(c));
  const doUpdate = update.length ? `DO UPDATE SET ${update.map((c) => `${c} = excluded.${c}`).join(', ')} WHERE ${t.table}.${t.orgColumn} = excluded.${t.orgColumn}` : 'DO NOTHING';
  return env.DB.prepare(`INSERT INTO ${t.table} (${all.join(', ')}) SELECT ${select} FROM json_each(?2) WHERE true ON CONFLICT(${conflict.join(', ')}) ${doUpdate}`).bind(orgId, payload);
}

// Every id a batch names (its rows' own ids and what they point to) that
// belongs to another org on this installation: one statement, one JSON
// parameter per table named.
async function foreignIds(env: Env, orgId: string, tables: SyncBatchTable[]): Promise<{ table: string; id: string }[]> {
  const ids = new Map<string, Set<string>>();
  const add = (table: string, id: unknown) => {
    if (typeof id !== 'string' || !id) return;
    if (!ids.has(table)) ids.set(table, new Set());
    ids.get(table)!.add(id);
  };
  for (const bt of tables) {
    const t = SYNC_TABLE.get(bt.table)!;
    for (const row of bt.upserts ?? []) {
      if (t.key.length === 1 && t.key[0] === 'id') add(t.table, row.id);
      for (const [column, target] of Object.entries(SYNC_REFS[t.table] ?? {})) add(target, row[column]);
    }
  }
  if (ids.size === 0) return [];
  const parts: string[] = [];
  const params: unknown[] = [orgId];
  // One column per table (D1 allows only a few terms in a compound SELECT).
  for (const [table, set] of ids) {
    params.push(JSON.stringify([...set]));
    parts.push(`(SELECT json_group_array(id) FROM ${table} WHERE org_id != ?1 AND id IN (SELECT value FROM json_each(?${params.length}))) AS ${table}`);
  }
  const row = await env.DB.prepare(`SELECT ${parts.join(', ')}`).bind(...params).first<Record<string, string>>();
  return Object.entries(row ?? {}).flatMap(([table, list]) => (JSON.parse(list || '[]') as string[]).map((id) => ({ table, id })));
}

function validBatch(body: unknown): body is SyncBatch {
  const b = body as SyncBatch;
  if (!b || !Number.isSafeInteger(b.toSeq) || b.toSeq < 0 || !Array.isArray(b.tables)) return false;
  const seen = new Set<string>();
  for (const t of b.tables) {
    if (!t || !SYNC_TABLE.has(t.table) || seen.has(t.table)) return false;
    seen.add(t.table);
    if (t.upserts !== undefined && (!Array.isArray(t.upserts) || t.upserts.some((r) => !r || typeof r !== 'object' || Array.isArray(r)))) return false;
    if (t.deletes !== undefined && (!Array.isArray(t.deletes) || t.deletes.some((k) => !Array.isArray(k)))) return false;
    if (t.table === 'organizations' && (t.upserts?.length ?? 0) > 1) return false;
  }
  return true;
}

// A secret table's rows arrive decrypted (over TLS) and are stored encrypted
// under this installation's own key for the org.
async function encryptSecrets(t: SyncTable, rows: Record<string, unknown>[], dek: string): Promise<Record<string, unknown>[]> {
  if (t.secret !== 'payment') return rows;
  return Promise.all(
    rows.map(async (row) => {
      const config = typeof row.config === 'string' ? row.config : JSON.stringify(row.config ?? {});
      const enc = await encryptWithKey(config, dek);
      const { config: _drop, ...rest } = row;
      return { ...rest, config_ciphertext: enc.ciphertext, config_iv: enc.iv };
    })
  );
}

async function applyBatch(request: Request, env: Env): Promise<Response> {
  const key = bearer(request);
  if (!key) return json({ error: 'Unauthorized' }, 401);
  const text = await request.text();
  if (text.length > MAX_BATCH_BYTES) return syncError('sync_batch_too_large', 'Batch too large', 413, { maxBytes: MAX_BATCH_BYTES });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const mismatch = versionMismatch(body as SyncBatch);
  if (mismatch) return mismatch;
  const link = await replicaFor(env, await sha256Hex(key));
  if (!link) return json({ error: 'Unauthorized' }, 401);
  if (!validBatch(body)) return json({ error: 'Invalid batch' }, 400);
  if (tableStatements(body.tables) > MAX_TABLE_STATEMENTS) {
    return syncError('sync_batch_too_large', 'Batch too large', 413, { maxTableStatements: MAX_TABLE_STATEMENTS });
  }
  const orgId = link.org_id;

  // Ids of another org: refused as a whole, nothing applied, never overwritten.
  const foreign = await foreignIds(env, orgId, body.tables);
  if (foreign.length) return syncError('sync_foreign_ids', 'The batch names rows of another organisation', 409, { refused: foreign.slice(0, 20) });

  const byTable = new Map(body.tables.map((t) => [t.table, t]));
  const deletes: D1PreparedStatement[] = [];
  const upserts: D1PreparedStatement[] = [];
  let dek: string | null = null;
  // Deletes children first, inserts parents first (foreign keys).
  for (const t of [...SYNC_TABLES].reverse()) {
    const keys = byTable.get(t.table)?.deletes;
    if (keys?.length) {
      const s = deleteStatement(env, t, orgId, keys);
      if (s) deletes.push(s);
    }
  }
  for (const t of SYNC_TABLES) {
    let rows = byTable.get(t.table)?.upserts;
    if (!rows?.length) continue;
    if (t.secret) {
      dek ??= await unwrapDataKey({ ciphertext: link.dek_ciphertext, iv: link.dek_iv }, env.ENCRYPTION_KEY);
      rows = await encryptSecrets(t, rows, dek);
    }
    upserts.push(upsertStatement(env, t, orgId, rows));
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO sync_applying (org_id) VALUES (?)').bind(orgId),
    ...deletes,
    ...upserts,
    env.DB.prepare('DELETE FROM sync_applying WHERE org_id = ?').bind(orgId),
    env.DB.prepare("UPDATE sync_links SET last_seq = MAX(last_seq, ?), last_sync_at = ?, last_error = NULL WHERE org_id = ? AND role = 'replica'").bind(body.toSeq, now, orgId),
  ]);
  return json({ lastSeq: Math.max(link.last_seq, body.toSeq) });
}

export async function dispatchSyncRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (request.method === 'POST' && pathname === '/organizations/backups') return createInvite(request, env);
  if (request.method === 'POST' && pathname === '/sync/hello') return hello(request, env);
  if (request.method === 'POST' && pathname === '/sync/batch') return applyBatch(request, env);
  return null;
}

// For tests and the status page: the statements a batch costs at most.
export const MAX_BATCH_QUERIES = 2 + FIXED_STATEMENTS + MAX_TABLE_STATEMENTS;
