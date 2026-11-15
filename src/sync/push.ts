// Offline sync, the box's side (OFFLINE.md): link an org to its backup, send
// its changes, say how far it is.
//
//   POST   /organizations/:orgId/backup   (admin) { code } → links this org to a cloud backup, starts the first sync
//   GET    /organizations/:orgId/backup   (admin) → the link's status (on the cloud: that it is a backup)
//   DELETE /organizations/:orgId/backup   (admin) → stops sending (the cloud keeps its copy)
//   POST   /organizations/:orgId/backup/promote (admin, on the cloud) { confirm: <org name> } → the backup becomes the org in use
//   GET    /organizations/:orgId/backup/connection (kassa) → whether this box reaches the internet, as far as the sync knows
//
// The push (pushOnce) reads the oldest changes from sync_outbox, sends the
// rows as they are now (state-based: a key whose row is gone becomes a
// delete), and drops what the cloud confirmed. A Node timer drives it
// (SyncPusher, started by node.ts): a box always runs on Node.
import type { Env } from '../env';
import { json } from '../http';
import { errorJson } from '../errors';
import { extractCaller, refuseUnlessOrgMember, requireOrgRole } from '../organizations/auth';
import { decryptWithKey, encryptWithKey } from '../organizations/crypto';
import { getOrgDataKey } from '../organizations/organizations';
import { EXPORT_TABLES } from '../org-transfer';
import { MAX_BATCH_BYTES, MAX_TABLE_STATEMENTS, parseLinkCode, type SyncBatch, type SyncBatchTable } from './replica';
import { SYNC_PROTOCOL, SYNC_SCHEMA, SYNC_TABLES, type SyncTable } from './spec';

// How the box reaches the cloud: fetch, replaceable in tests.
export type SyncTransport = (url: string, init: RequestInit) => Promise<Response>;
let transport: SyncTransport = (url, init) => fetch(url, init);
export function setSyncTransport(t: SyncTransport | null) {
  transport = t ?? ((url, init) => fetch(url, init));
}

// Outbox rows per batch at most; fewer when the rows are big (icons, logos).
export const BATCH_ROWS = 500;
// Tables per batch at most: each can take an upsert and a delete statement on the cloud.
const BATCH_TABLES = Math.floor(MAX_TABLE_STATEMENTS / 2);
export const HEARTBEAT_MS = 5 * 60_000;

interface SourceLink {
  org_id: string;
  remote_url: string;
  key_ciphertext: string;
  key_iv: string;
  created_at: string;
  last_sync_at: string | null;
  last_seq: number;
  last_error: string | null;
  backfill_done_at: string | null;
}

async function sourceLink(env: Env, orgId: string): Promise<SourceLink | null> {
  return env.DB.prepare("SELECT * FROM sync_links WHERE org_id = ? AND role = 'source'").bind(orgId).first<SourceLink>();
}

async function call(url: string, key: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await transport(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

// --- The first sync: every row of the org into the outbox ---

// Rows of an open tab or an open shift: sent right after the settings, so
// the cloud is usable at once; the history follows.
function openCondition(t: SyncTable): string | null {
  if (t.table === 'tabs' || t.table === 'shifts') return "status = 'open'";
  if (t.table === 'cash_movements') return "shift_id IN (SELECT id FROM shifts WHERE org_id = ?1 AND status = 'open')";
  if (t.columns.includes('tab_id')) return "tab_id IN (SELECT id FROM tabs WHERE org_id = ?1 AND status = 'open')";
  return null;
}

const ORDER_BY = new Map(EXPORT_TABLES.map((s) => [s.table, s.orderBy]));

// In foreign-key order, so a row never reaches the cloud before what it
// points to (batches go in sequence order): the settings, then what's open,
// then the rest. One statement per table and part; a box has no query cap
// (Node), and it still fits in one invocation's 50.
function backfillStatements(env: Env, orgId: string, now: string): D1PreparedStatement[] {
  const keyJson = (t: SyncTable) => `json_array(${t.key.join(', ')})`;
  const insert = (t: SyncTable, where: string) =>
    env.DB.prepare(
      `INSERT INTO sync_outbox (org_id, table_name, row_key, op, created_at)
       SELECT ?1, '${t.table}', ${keyJson(t)}, 'backfill', ?2 FROM ${t.table} WHERE ${t.orgColumn} = ?1${where ? ` AND ${where}` : ''} ORDER BY ${ORDER_BY.get(t.table) ?? 'rowid'}`
    ).bind(orgId, now);
  const settings = SYNC_TABLES.filter((t) => !openCondition(t));
  const live = SYNC_TABLES.filter((t) => openCondition(t));
  return [
    ...settings.map((t) => insert(t, '')),
    ...live.map((t) => insert(t, openCondition(t)!)),
    ...live.map((t) => insert(t, `NOT (${openCondition(t)})`)),
  ];
}

// --- Routes ---

async function authorizeAdmin(request: Request, env: Env, orgId: string): Promise<Response | null> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!(await requireOrgRole(env, orgId, caller, ['admin']))) return json({ error: 'Forbidden' }, 403);
  return null;
}

async function link(request: Request, env: Env, orgId: string): Promise<Response> {
  // Only a box runs the push loop: on a cloud the changes would wait forever.
  if (!env.SYNC_SENDER) return errorJson('backup_not_local', 409);
  const refused = await authorizeAdmin(request, env, orgId);
  if (refused) return refused;
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  const parsed = typeof body.code === 'string' ? parseLinkCode(body.code) : null;
  if (!parsed) return errorJson('backup_code_invalid', 400);
  if (await env.DB.prepare('SELECT 1 FROM sync_links WHERE org_id = ?').bind(orgId).first()) return errorJson('backup_already_linked', 409);

  const org = await env.DB.prepare('SELECT name, locale FROM organizations WHERE id = ?').bind(orgId).first<{ name: string; locale: string }>();
  if (!org) return errorJson('org_not_found', 404);
  let hello: { status: number; body: any };
  try {
    hello = await call(parsed.url, parsed.key, '/sync/hello', { protocol: SYNC_PROTOCOL, schema: SYNC_SCHEMA, orgId, name: org.name, locale: org.locale });
  } catch (err) {
    return errorJson('backup_unreachable', 502, { details: (err as Error).message });
  }
  if (hello.status === 409 && hello.body?.code === 'sync_version_mismatch') return errorJson('backup_version_mismatch', 409);
  if (hello.status === 409 && hello.body?.code === 'sync_org_exists') return errorJson('backup_org_exists', 409);
  if (hello.status === 401) return errorJson('backup_code_invalid', 400);
  if (hello.status >= 300) return errorJson('backup_unreachable', 502, { details: hello.body?.error ?? String(hello.status) });

  const dek = await getOrgDataKey(env, orgId);
  const key = await encryptWithKey(parsed.key, dek!);
  const now = new Date().toISOString();
  // The link first: from then on the triggers record every change; the
  // backfill in the same transaction records every row there already was.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sync_links (org_id, role, remote_url, key_ciphertext, key_iv, created_at, last_seq) VALUES (?, 'source', ?, ?, ?, ?, ?)").bind(
      orgId,
      parsed.url,
      key.ciphertext,
      key.iv,
      now,
      Number(hello.body?.lastSeq) || 0
    ),
    ...backfillStatements(env, orgId, now),
  ]);
  return json(await status(env, orgId), 201);
}

export interface BackupStatus {
  role: 'none' | 'source' | 'replica';
  // This installation can send a backup (a box); else it only receives one (the cloud).
  sends: boolean;
  remoteUrl?: string;
  linkedAt?: string;
  lastSyncAt?: string | null;
  lastError?: string | null;
  // Changes not yet at the cloud; of the first sync, rows still to send.
  pending?: number;
  pendingFirstSync?: number;
  oldestPendingAt?: string | null;
  firstSyncDoneAt?: string | null;
  protocol: number;
  schema: string;
}

export async function status(env: Env, orgId: string): Promise<BackupStatus> {
  const versions = { sends: !!env.SYNC_SENDER, protocol: SYNC_PROTOCOL, schema: SYNC_SCHEMA };
  const link = await env.DB.prepare('SELECT * FROM sync_links WHERE org_id = ?').bind(orgId).first<SourceLink & { role: string }>();
  if (!link) return { role: 'none', ...versions };
  if (link.role === 'replica') return { role: 'replica', linkedAt: link.created_at, lastSyncAt: link.last_sync_at, ...versions };
  const counts = await env.DB.prepare(
    "SELECT COUNT(*) AS pending, COALESCE(SUM(op = 'backfill'), 0) AS backfill, MIN(created_at) AS oldest FROM sync_outbox WHERE org_id = ?"
  )
    .bind(orgId)
    .first<{ pending: number; backfill: number; oldest: string | null }>();
  return {
    role: 'source',
    remoteUrl: link.remote_url,
    linkedAt: link.created_at,
    lastSyncAt: link.last_sync_at,
    lastError: link.last_error,
    pending: counts?.pending ?? 0,
    pendingFirstSync: counts?.backfill ?? 0,
    oldestPendingAt: counts?.oldest ?? null,
    firstSyncDoneAt: link.backfill_done_at,
    ...versions,
  };
}

async function unlink(request: Request, env: Env, orgId: string): Promise<Response> {
  const refused = await authorizeAdmin(request, env, orgId);
  if (refused) return refused;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sync_links WHERE org_id = ? AND role = 'source'").bind(orgId),
    env.DB.prepare('DELETE FROM sync_outbox WHERE org_id = ?').bind(orgId),
  ]);
  return json(await status(env, orgId));
}

// For the kassa's "no internet" bar: only a box with a backup knows (its
// sync reaches the cloud or not; at most a heartbeat, 5 minutes, behind).
// Without a link: null, nothing to show.
async function connection(request: Request, env: Env, orgId: string): Promise<Response> {
  const refused = await refuseUnlessOrgMember(request, env, orgId);
  if (refused) return refused;
  const link = await env.DB.prepare("SELECT last_sync_at, last_error FROM sync_links WHERE org_id = ? AND role = 'source'")
    .bind(orgId)
    .first<{ last_sync_at: string | null; last_error: string | null }>();
  if (!link) return json({ linked: false, online: null, lastSyncAt: null });
  return json({ linked: true, online: !link.last_error?.startsWith('unreachable'), lastSyncAt: link.last_sync_at });
}

// Disaster recovery (OFFLINE.md): the box broke, the backup becomes the org
// in use. Deliberate and final: the link goes, so the old box (should it
// come back) can't send anything any more (its key is unknown here), and
// people can change everything again. Behind the org's name typed as a
// confirmation.
async function promote(request: Request, env: Env, orgId: string): Promise<Response> {
  const refused = await authorizeAdmin(request, env, orgId);
  if (refused) return refused;
  const body = (await request.json().catch(() => ({}))) as { confirm?: unknown };
  const org = await env.DB.prepare('SELECT name FROM organizations WHERE id = ?').bind(orgId).first<{ name: string }>();
  if (!org) return errorJson('org_not_found', 404);
  if (!(await env.DB.prepare("SELECT 1 FROM sync_links WHERE org_id = ? AND role = 'replica'").bind(orgId).first())) return errorJson('backup_not_replica', 409);
  if (typeof body.confirm !== 'string' || body.confirm.trim() !== org.name.trim()) return errorJson('backup_confirm_name', 400);
  await env.DB.prepare("DELETE FROM sync_links WHERE org_id = ? AND role = 'replica'").bind(orgId).run();
  return json(await status(env, orgId));
}

export async function dispatchBackupRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const p = pathname.match(/^\/organizations\/([^/]+)\/backup\/promote$/);
  if (p && request.method === 'POST') return promote(request, env, decodeURIComponent(p[1]));
  const c = pathname.match(/^\/organizations\/([^/]+)\/backup\/connection$/);
  if (c && request.method === 'GET') return connection(request, env, decodeURIComponent(c[1]));
  const m = pathname.match(/^\/organizations\/([^/]+)\/backup$/);
  if (!m) return null;
  const orgId = decodeURIComponent(m[1]);
  if (request.method === 'POST') return link(request, env, orgId);
  if (request.method === 'DELETE') return unlink(request, env, orgId);
  if (request.method === 'GET') {
    const refused = await authorizeAdmin(request, env, orgId);
    return refused ?? json(await status(env, orgId));
  }
  return null;
}

// --- Pushing ---

interface OutboxRow {
  seq: number;
  table_name: string;
  row_key: string;
}

export type PushResult =
  | { kind: 'sent'; rows: number; more: boolean }
  | { kind: 'idle' }
  | { kind: 'error'; error: string; retryAt?: number };

const nextUtcDay = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

// The outbox rows of one batch: oldest first, at most `limit` rows and BATCH_TABLES tables.
function cut(rows: OutboxRow[], limit: number): OutboxRow[] {
  const tables = new Set<string>();
  const out: OutboxRow[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (!tables.has(r.table_name) && tables.size >= BATCH_TABLES) break;
    tables.add(r.table_name);
    out.push(r);
  }
  return out;
}

// The rows as they are now, per table: present keys become upserts (in the
// order of their last change), missing ones deletes.
async function readBatch(env: Env, orgId: string, rows: OutboxRow[], dek: string | null): Promise<SyncBatchTable[]> {
  const byTable = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Map());
    byTable.get(r.table_name)!.set(r.row_key, r.seq); // the last change of a key wins
  }
  const specs = SYNC_TABLES.filter((t) => byTable.has(t.table));
  // By the table's own key (its primary key index), sent as JSON arrays.
  const select = (t: SyncTable) => {
    const keyed = `json_array(${t.key.join(', ')}) AS __key`;
    const match =
      t.key.length === 0
        ? ''
        : t.key.length === 1
          ? ` AND ${t.key[0]} IN (SELECT json_extract(value, '$[0]') FROM json_each(?2))`
          : ` AND (${t.key.join(', ')}) IN (SELECT ${t.key.map((_, i) => `json_extract(value, '$[${i}]')`).join(', ')} FROM json_each(?2))`;
    const statement = env.DB.prepare(`SELECT ${t.columns.join(', ')}, ${keyed} FROM ${t.table} WHERE ${t.orgColumn} = ?1${match}`);
    const keys = [...byTable.get(t.table)!.keys()].map((k) => JSON.parse(k));
    return t.key.length ? statement.bind(orgId, JSON.stringify(keys)) : statement.bind(orgId);
  };
  const results = specs.length ? await env.DB.batch(specs.map(select)) : [];
  const out: SyncBatchTable[] = [];
  for (let i = 0; i < specs.length; i++) {
    const t = specs[i];
    const wanted = byTable.get(t.table)!;
    const found = (results[i].results ?? []) as Record<string, unknown>[];
    const present = new Set(found.map((r) => r.__key as string));
    const upserts = await Promise.all(
      found
        .sort((a, b) => wanted.get(a.__key as string)! - wanted.get(b.__key as string)!)
        .map(async ({ __key, ...row }) => {
          if (t.secret !== 'payment') return row;
          const { config_ciphertext, config_iv, ...rest } = row;
          const config = config_ciphertext && config_iv && dek ? await decryptWithKey({ ciphertext: config_ciphertext as string, iv: config_iv as string }, dek) : '{}';
          return { ...rest, config };
        })
    );
    const deletes = [...wanted.keys()].filter((k) => !present.has(k)).map((k) => JSON.parse(k) as unknown[]);
    out.push({ table: t.table, ...(upserts.length ? { upserts } : {}), ...(deletes.length ? { deletes } : {}) });
  }
  return out;
}

// One batch for one org: what changed, sent; or a heartbeat when nothing
// did for HEARTBEAT_MS. Never throws: an error is recorded on the link.
export async function pushOnce(env: Env, orgId: string, now = Date.now()): Promise<PushResult> {
  const link = await sourceLink(env, orgId);
  if (!link) return { kind: 'idle' };
  const fail = async (error: string, retryAt?: number): Promise<PushResult> => {
    await env.DB.prepare("UPDATE sync_links SET last_error = ? WHERE org_id = ? AND role = 'source'").bind(error.slice(0, 500), orgId).run();
    return { kind: 'error', error, retryAt };
  };
  try {
    const dek = await getOrgDataKey(env, orgId);
    if (!dek) return fail('org_not_found');
    const key = await decryptWithKey({ ciphertext: link.key_ciphertext, iv: link.key_iv }, dek);
    const { results } = await env.DB.prepare('SELECT seq, table_name, row_key FROM sync_outbox WHERE org_id = ? ORDER BY seq LIMIT ?').bind(orgId, BATCH_ROWS).all<OutboxRow>();
    const outbox = results ?? [];
    if (!outbox.length) {
      const quiet = !link.last_sync_at || now - Date.parse(link.last_sync_at) >= HEARTBEAT_MS;
      if (!quiet) return { kind: 'idle' };
    }

    // Big rows (icons, logos): halve until the batch fits.
    let limit = BATCH_ROWS;
    let rows = cut(outbox, limit);
    let batch: SyncBatch;
    for (;;) {
      const tables = await readBatch(env, orgId, rows, dek);
      batch = { protocol: SYNC_PROTOCOL, schema: SYNC_SCHEMA, toSeq: rows.length ? rows[rows.length - 1].seq : link.last_seq, tables };
      if (JSON.stringify(batch).length <= MAX_BATCH_BYTES || rows.length <= 1) break;
      limit = Math.max(1, Math.floor(rows.length / 2));
      rows = cut(outbox, limit);
    }

    let res: { status: number; body: any };
    try {
      res = await call(link.remote_url, key, '/sync/batch', batch);
    } catch (err) {
      return fail(`unreachable: ${(err as Error).message}`);
    }
    if (res.status === 429 && res.body?.code === 'sync_cloud_daily_limit') return fail('sync_cloud_daily_limit', nextUtcDay(now));
    if (res.status !== 200) return fail(res.body?.code ?? `${res.status}: ${res.body?.error ?? ''}`);

    const sentAt = new Date(now).toISOString();
    const toSeq = batch.toSeq;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sync_outbox WHERE org_id = ? AND seq <= ?').bind(orgId, toSeq),
      env.DB.prepare("UPDATE sync_links SET last_seq = MAX(last_seq, ?), last_sync_at = ?, last_error = NULL WHERE org_id = ? AND role = 'source'").bind(toSeq, sentAt, orgId),
      env.DB.prepare(
        "UPDATE sync_links SET backfill_done_at = ? WHERE org_id = ? AND role = 'source' AND backfill_done_at IS NULL AND NOT EXISTS (SELECT 1 FROM sync_outbox WHERE org_id = ? AND op = 'backfill')"
      ).bind(sentAt, orgId, orgId),
    ]);
    return { kind: 'sent', rows: rows.length, more: outbox.length > rows.length || outbox.length === BATCH_ROWS };
  } catch (err) {
    return fail((err as Error).message);
  }
}

// --- The loop (Node) ---

// Every source org of this box, every few seconds while there's work; after
// an error it waits longer each time (up to 5 minutes), after the cloud's
// daily write limit until the next UTC day.
export class SyncPusher {
  private retryAt = new Map<string, number>();
  private failures = new Map<string, number>();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly env: Env,
    private readonly everyMs = 10_000
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { results } = await this.env.DB.prepare("SELECT org_id FROM sync_links WHERE role = 'source'").all<{ org_id: string }>();
      for (const { org_id } of results ?? []) {
        if ((this.retryAt.get(org_id) ?? 0) > now) continue;
        // Up to 20 batches in a row per tick, so one org's first sync doesn't hold up the others for long.
        for (let i = 0; i < 20; i++) {
          const result = await pushOnce(this.env, org_id, now);
          if (result.kind === 'error') {
            const n = (this.failures.get(org_id) ?? 0) + 1;
            this.failures.set(org_id, n);
            this.retryAt.set(org_id, result.retryAt ?? now + Math.min(300_000, 10_000 * 2 ** (n - 1)));
            break;
          }
          this.failures.delete(org_id);
          this.retryAt.delete(org_id);
          if (result.kind === 'idle' || !result.more) break;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
