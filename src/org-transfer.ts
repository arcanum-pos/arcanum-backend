// Org data export / import — for moving an org to its own installation
// (self-hosting), or copying it within this one.
//
//   GET  /organizations/:orgId/export[?secrets=1]   (admin) → one readable JSON file
//   POST /organizations/import/start                (any logged-in user, like creating an org)
//   POST /organizations/:orgId/import/chunk         (admin of the org being imported)
//   POST /organizations/:orgId/import/finish        (admin) → verifies row counts, activates
//   POST /organizations/:orgId/import/abort         (admin) → removes the half-imported org
//
// Why browser-driven chunks: on the Workers Free plan D1 allows only 50
// queries per invocation (every statement in a batch counts) and a Worker
// gets ~10 ms CPU. Each chunk is one table's rows inserted with a single
// `INSERT … SELECT … FROM json_each(?)` statement, so the query count
// depends on the number of tables, never on the number of rows.
//
// Every id is remapped by XOR with a random per-import key: collision-free
// (XOR is a bijection) and deterministic, so a retried chunk inserts nothing
// twice (INSERT OR IGNORE), and an org can even be imported as a copy into
// the installation it was exported from.
//
// Deliberately NOT exported: the org's data key (a new one is created on
// import), its custom domain and identity provider (they belong to an
// installation's setup, not to the org's data), devices (they re-register
// with the new installation), and members' identity bindings (members come
// back as pending invites and reconnect on their first login).
import type { Env } from './env';
import { json } from './http';
import { decryptWithKey, encryptWithKey, generateDataKey, wrapDataKey } from './organizations/crypto';
import { extractCaller, requireOrgRole } from './organizations/auth';
import { getOrgDataKey } from './organizations/organizations';
import { mayCreateOrganizations, NOT_AN_INSTANCE_ADMIN } from './organizations/instance-admins';

export const EXPORT_FORMAT = 'arcanum-org-export';
export const EXPORT_VERSION = 1;
const MAX_CHUNK_ROWS = 2000;

export interface TableSpec {
  table: string;
  // Exported (and imported) columns, as stored.
  columns: string[];
  // Every other column of the table, with why it's left out. A test checks
  // that columns + excluded covers the table exactly, so a new migration
  // can't silently fall out of the export.
  excluded: Record<string, string>;
  // Columns holding ids (own id + references) — remapped on import.
  remap: string[];
  orderBy: string;
  secret?: 'payment' | 'smtp' | 'gmail';
}

const ORG = { org_id: 'set to the new org on import' };

// In foreign-key order: import inserts them in exactly this order.
export const EXPORT_TABLES: TableSpec[] = [
  {
    table: 'memberships',
    columns: ['id', 'invited_email', 'role', 'status', 'invited_at', 'accepted_at'],
    excluded: { ...ORG, user_sub: "bound to this installation's identity provider", issuer: "bound to this installation's identity provider" },
    remap: ['id'],
    orderBy: 'invited_at, rowid',
  },
  { table: 'events', columns: ['id', 'name', 'event_date', 'created_at'], excluded: ORG, remap: ['id'], orderBy: 'created_at, rowid' },
  { table: 'categories', columns: ['id', 'name', 'position', 'created_at'], excluded: ORG, remap: ['id'], orderBy: 'position, rowid' },
  { table: 'prep_stations', columns: ['id', 'name', 'position', 'created_at'], excluded: ORG, remap: ['id'], orderBy: 'position, rowid' },
  {
    table: 'products',
    columns: ['id', 'category_id', 'prep_station_id', 'name', 'vat_rate_bp', 'archived_at', 'created_at'],
    excluded: ORG,
    remap: ['id', 'category_id', 'prep_station_id'],
    orderBy: 'created_at, rowid',
  },
  {
    table: 'product_variants',
    columns: ['id', 'product_id', 'name', 'code', 'position', 'archived_at', 'created_at'],
    excluded: ORG,
    remap: ['id', 'product_id'],
    orderBy: 'created_at, rowid',
  },
  { table: 'catalogs', columns: ['id', 'name', 'is_default', 'archived_at', 'created_at', 'updated_at'], excluded: ORG, remap: ['id'], orderBy: 'created_at, rowid' },
  { table: 'catalog_sections', columns: ['id', 'catalog_id', 'name', 'position'], excluded: ORG, remap: ['id', 'catalog_id'], orderBy: 'rowid' },
  {
    table: 'catalog_entries',
    columns: ['id', 'catalog_id', 'section_id', 'variant_id', 'price_cents', 'visible', 'position', 'quick_quantities'],
    excluded: ORG,
    remap: ['id', 'catalog_id', 'section_id', 'variant_id'],
    orderBy: 'rowid',
  },
  { table: 'org_counters', columns: ['name', 'value'], excluded: ORG, remap: [], orderBy: 'name' },
  {
    table: 'tabs',
    columns: [
      'id', 'number', 'label', 'status', 'slot_id', 'event_id', 'opened_device_id', 'opened_device_name', 'opened_by_name', 'opened_by_email',
      'opened_at', 'closed_at', 'receipt_number', 'cancel_reason',
    ],
    excluded: ORG,
    remap: ['id', 'event_id'],
    orderBy: 'number',
  },
  {
    table: 'orders',
    columns: ['id', 'tab_id', 'source', 'catalog_id', 'device_id', 'device_name', 'user_name', 'user_email', 'submitted_at'],
    excluded: ORG,
    remap: ['id', 'tab_id', 'catalog_id'],
    orderBy: 'submitted_at, rowid',
  },
  {
    table: 'order_lines',
    columns: [
      'id', 'tab_id', 'order_id', 'item_code', 'variant_id', 'name', 'unit_price_cents', 'quantity', 'category', 'vat_rate_bp',
      'prep_station_id', 'prep_station_name', 'note', 'voids_line_id', 'void_reason', 'created_at',
    ],
    excluded: ORG,
    remap: ['id', 'tab_id', 'order_id', 'variant_id', 'prep_station_id', 'voids_line_id'],
    // A void line always comes after the line it voids.
    orderBy: 'created_at, rowid',
  },
  {
    table: 'charges',
    columns: [
      'id', 'method', 'status', 'provider_status', 'amount_cents', 'description', 'items', 'slot_id', 'device_id', 'device_name', 'user_name',
      'user_email', 'created_at', 'resolved_at', 'transaction_code', 'error_message', 'provider_ref', 'expires_at', 'tab_id', 'tip_cents',
    ],
    excluded: {
      ...ORG,
      pos_terminal_id: "a devicehub terminal of this installation — devices re-register",
      provider_data: 'callback token / QR link, only meaningful while a payment is in progress',
    },
    remap: ['id', 'tab_id'],
    orderBy: 'created_at, rowid',
  },
  {
    table: 'transactions',
    columns: [
      'id', 'amount_cents', 'description', 'method', 'items', 'slot_id', 'device_id', 'device_name', 'user_name', 'user_email', 'event_id', 'tab_id',
      'tip_cents', 'completed_at',
    ],
    excluded: ORG,
    remap: ['id', 'event_id', 'tab_id'],
    orderBy: 'completed_at, rowid',
  },
  { table: 'mail_provider', columns: ['provider', 'updated_at'], excluded: ORG, remap: [], orderBy: 'org_id' },
  // --- Secrets: only with ?secrets=1, exported decrypted, re-encrypted with the new org's key on import.
  {
    table: 'payment_provider_credentials',
    columns: ['provider', 'updated_at'],
    excluded: { ...ORG, config_ciphertext: 'exported decrypted as `config`', config_iv: 'exported decrypted as `config`' },
    remap: [],
    orderBy: 'provider',
    secret: 'payment',
  },
  {
    table: 'smtp_credentials',
    columns: ['host', 'port', 'username', 'from_address', 'from_name', 'updated_at'],
    excluded: { ...ORG, password_ciphertext: 'exported decrypted as `password`', password_iv: 'exported decrypted as `password`' },
    remap: [],
    orderBy: 'org_id',
    secret: 'smtp',
  },
  {
    table: 'gmail_api_credentials',
    columns: ['client_email', 'impersonated_user', 'from_name', 'updated_at'],
    excluded: { ...ORG, private_key_ciphertext: 'exported decrypted as `private_key`', private_key_iv: 'exported decrypted as `private_key`' },
    remap: [],
    orderBy: 'org_id',
    secret: 'gmail',
  },
];

const SPEC_BY_TABLE = new Map(EXPORT_TABLES.map((s) => [s.table, s]));

// --- Id remapping ---

// XOR the 128 bits of a UUID / 32-hex id with the import key, keeping its
// format (hyphenated or not). Anything else gets the key as a prefix —
// still unique and deterministic.
export function remapId(id: string | null, keyHex: string): string | null {
  if (id === null || id === undefined) return null;
  const hex = id.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return `${keyHex.slice(0, 8)}-${id}`;
  let out = '';
  for (let i = 0; i < 32; i++) out += (parseInt(hex[i], 16) ^ parseInt(keyHex[i], 16)).toString(16);
  return id.includes('-') ? `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}` : out;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function authorizeAdmin(request: Request, env: Env, orgId: string) {
  const caller = extractCaller(request);
  if (!caller) return { error: json({ error: 'Unauthorized' }, 401) };
  if (!(await requireOrgRole(env, orgId, caller, ['admin']))) return { error: json({ error: 'Forbidden' }, 403) };
  return { caller };
}

// --- Export ---

async function exportOrg(request: Request, env: Env, orgId: string): Promise<Response> {
  const auth = await authorizeAdmin(request, env, orgId);
  if (auth.error) return auth.error;
  const includeSecrets = new URL(request.url).searchParams.get('secrets') === '1';

  const org = await env.DB.prepare('SELECT id, name, logo_url, theme, created_at FROM organizations WHERE id = ?')
    .bind(orgId)
    .first<{ id: string; name: string; logo_url: string | null; theme: string | null; created_at: string }>();
  if (!org) return json({ error: 'Organisatie niet gevonden' }, 404);

  const specs = EXPORT_TABLES.filter((s) => !s.secret || includeSecrets);
  const results = await env.DB.batch(
    specs.map((s) => {
      const extra = s.secret === 'payment' ? ', config_ciphertext, config_iv' : s.secret === 'smtp' ? ', password_ciphertext, password_iv' : s.secret === 'gmail' ? ', private_key_ciphertext, private_key_iv' : '';
      return env.DB.prepare(`SELECT ${s.columns.join(', ')}${extra} FROM ${s.table} WHERE org_id = ? ORDER BY ${s.orderBy}`).bind(orgId);
    })
  );

  const dek = includeSecrets ? await getOrgDataKey(env, orgId) : null;
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    let data = (results[i].results || []) as Record<string, unknown>[];
    if (spec.secret && dek) data = await Promise.all(data.map((row) => decryptSecretRow(spec, row, dek)));
    tables[spec.table] = data;
  }

  const body = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { orgId: org.id, installation: env.PUBLIC_BASE_URL },
    includesSecrets: includeSecrets,
    organization: { name: org.name, logo_url: org.logo_url, theme: org.theme, created_at: org.created_at },
    tables,
  };
  const slug = org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'organisatie';
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="arcanum-export-${slug}-${body.exportedAt.slice(0, 10)}.json"`,
    },
  });
}

async function decryptSecretRow(spec: TableSpec, row: Record<string, unknown>, dek: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = Object.fromEntries(spec.columns.map((c) => [c, row[c]]));
  const decrypt = async (c: string, iv: string) =>
    row[c] && row[iv] ? decryptWithKey({ ciphertext: row[c] as string, iv: row[iv] as string }, dek) : null;
  if (spec.secret === 'payment') out.config = JSON.parse((await decrypt('config_ciphertext', 'config_iv')) || '{}');
  if (spec.secret === 'smtp') out.password = await decrypt('password_ciphertext', 'password_iv');
  if (spec.secret === 'gmail') out.private_key = await decrypt('private_key_ciphertext', 'private_key_iv');
  return out;
}

// --- Import ---

interface Manifest {
  counts: Record<string, number>;
  importerInFile?: boolean;
}

async function startImport(request: Request, env: Env): Promise<Response> {
  const caller = extractCaller(request);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!mayCreateOrganizations(env, caller.email)) return json({ error: NOT_AN_INSTANCE_ADMIN }, 403);
  const body = ((await request.json().catch(() => null)) || {}) as { manifest?: any; name?: unknown };
  const manifest = body.manifest;
  if (!manifest || manifest.format !== EXPORT_FORMAT) return json({ error: 'Dit is geen Arcanum-exportbestand' }, 400);
  if (manifest.version !== EXPORT_VERSION) return json({ error: `Exportversie ${manifest.version} wordt niet ondersteund (verwacht ${EXPORT_VERSION})` }, 400);

  const org = (manifest.organization || {}) as { name?: unknown; logo_url?: unknown; theme?: unknown };
  const name = (typeof body.name === 'string' && body.name.trim()) || (typeof org.name === 'string' && org.name.trim()) || '';
  if (!name || name.length > 100) return json({ error: 'De organisatie heeft een naam nodig (max 100 tekens)' }, 400);

  const counts: Record<string, number> = {};
  for (const spec of EXPORT_TABLES) {
    const n = Number(manifest.counts?.[spec.table] ?? 0);
    if (!Number.isInteger(n) || n < 0) return json({ error: `Ongeldig aantal voor ${spec.table}` }, 400);
    counts[spec.table] = n;
  }

  const orgId = crypto.randomUUID();
  const now = new Date().toISOString();
  const wrapped = await wrapDataKey(generateDataKey(), env.ENCRYPTION_KEY);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organizations (id, name, logo_url, theme, dek_ciphertext, dek_iv, created_at, created_by_sub, import_status, import_key, import_manifest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'importing', ?, ?)`
    ).bind(
      orgId,
      name,
      typeof org.logo_url === 'string' ? org.logo_url : null,
      typeof org.theme === 'string' ? org.theme : null,
      wrapped.ciphertext,
      wrapped.iv,
      now,
      caller.sub,
      randomHex(16),
      JSON.stringify({ counts } satisfies Manifest)
    ),
    env.DB.prepare(
      `INSERT INTO memberships (id, org_id, user_sub, issuer, invited_email, role, status, invited_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?, ?)`
    ).bind(crypto.randomUUID(), orgId, caller.sub, caller.issuer, caller.email.toLowerCase(), now, now),
  ]);
  return json({ orgId, tables: EXPORT_TABLES.map((s) => s.table), maxChunkRows: MAX_CHUNK_ROWS }, 201);
}

async function loadImportingOrg(env: Env, orgId: string) {
  return env.DB.prepare('SELECT import_status, import_key, import_manifest FROM organizations WHERE id = ?')
    .bind(orgId)
    .first<{ import_status: string | null; import_key: string | null; import_manifest: string | null }>();
}

async function importChunk(request: Request, env: Env, orgId: string): Promise<Response> {
  const auth = await authorizeAdmin(request, env, orgId);
  if (auth.error) return auth.error;
  const state = await loadImportingOrg(env, orgId);
  if (!state || state.import_status !== 'importing' || !state.import_key) return json({ error: 'Deze organisatie wordt niet (meer) geïmporteerd' }, 409);

  const body = ((await request.json().catch(() => null)) || {}) as { table?: unknown; rows?: unknown };
  const spec = typeof body.table === 'string' ? SPEC_BY_TABLE.get(body.table) : undefined;
  if (!spec) return json({ error: 'Onbekende tabel' }, 400);
  if (!Array.isArray(body.rows)) return json({ error: 'rows must be an array' }, 400);
  if (body.rows.length > MAX_CHUNK_ROWS) return json({ error: `Maximaal ${MAX_CHUNK_ROWS} rijen per stuk` }, 400);
  if (body.rows.length === 0) return json({ ok: true, inserted: 0 });

  const key = state.import_key;
  const statements: D1PreparedStatement[] = [];
  let columns = ['org_id', ...spec.columns];
  let rows: Record<string, unknown>[] = (body.rows as Record<string, unknown>[]).map((raw) => {
    const row: Record<string, unknown> = { org_id: orgId };
    for (const c of spec.columns) row[c] = raw?.[c] ?? null;
    for (const c of spec.remap) row[c] = remapId(row[c] as string | null, key);
    return row;
  });

  if (spec.table === 'memberships') {
    // Everyone comes back as a pending invite: their identity binding
    // belongs to the old installation's identity provider. The importer's
    // own row already exists (active admin) — theirs is ignored by the
    // (org_id, invited_email) unique index, and noted for /finish.
    const importerEmail = auth.caller!.email.toLowerCase();
    const raw = body.rows as Record<string, unknown>[];
    if (raw.some((r) => String(r?.invited_email || '').toLowerCase() === importerEmail)) {
      statements.push(
        env.DB.prepare(`UPDATE organizations SET import_manifest = json_set(import_manifest, '$.importerInFile', json('true')) WHERE id = ?`).bind(orgId)
      );
    }
    rows = rows.map((r) => ({ ...r, invited_email: String(r.invited_email || '').toLowerCase(), status: 'pending', accepted_at: null }));
  }
  if (spec.table === 'charges') {
    // Nothing can still complete a payment that was in progress at export time.
    columns = [...columns, 'provider_data'];
    rows = rows.map((r) => ({
      ...r,
      provider_data: '{}',
      ...(r.status === 'pending' ? { status: 'failed', error_message: 'Niet afgerond bij de export' } : {}),
    }));
  }
  if (spec.secret) {
    const dek = await getOrgDataKey(env, orgId);
    if (!dek) return json({ error: 'Organisatie niet gevonden' }, 404);
    const raw = body.rows as Record<string, unknown>[];
    const secretCols =
      spec.secret === 'payment' ? ['config_ciphertext', 'config_iv'] : spec.secret === 'smtp' ? ['password_ciphertext', 'password_iv'] : ['private_key_ciphertext', 'private_key_iv'];
    columns = [...columns, ...secretCols];
    rows = await Promise.all(
      rows.map(async (r, i) => {
        const plain =
          spec.secret === 'payment' ? JSON.stringify(raw[i]?.config ?? {}) : ((spec.secret === 'smtp' ? raw[i]?.password : raw[i]?.private_key) as string | null | undefined);
        if (plain === null || plain === undefined || plain === '') return { ...r, [secretCols[0]]: null, [secretCols[1]]: null };
        const enc = await encryptWithKey(String(plain), dek);
        return { ...r, [secretCols[0]]: enc.ciphertext, [secretCols[1]]: enc.iv };
      })
    );
  }

  // One statement for the whole chunk, however many rows.
  const select = columns.map((c) => `json_extract(value, '$.${c}')`).join(', ');
  statements.unshift(
    env.DB.prepare(`INSERT OR IGNORE INTO ${spec.table} (${columns.join(', ')}) SELECT ${select} FROM json_each(?)`).bind(
      JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))))
    )
  );
  const [insert] = await env.DB.batch(statements);
  return json({ ok: true, inserted: insert.meta.changes || 0 });
}

async function finishImport(request: Request, env: Env, orgId: string): Promise<Response> {
  const auth = await authorizeAdmin(request, env, orgId);
  if (auth.error) return auth.error;
  const state = await loadImportingOrg(env, orgId);
  if (!state || state.import_status !== 'importing') return json({ error: 'Deze organisatie wordt niet (meer) geïmporteerd' }, 409);
  const manifest = JSON.parse(state.import_manifest || '{"counts":{}}') as Manifest;

  const results = await env.DB.batch(EXPORT_TABLES.map((s) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${s.table} WHERE org_id = ?`).bind(orgId)));
  const tables: Record<string, { expected: number; imported: number }> = {};
  let ok = true;
  EXPORT_TABLES.forEach((spec, i) => {
    let imported = (results[i].results?.[0] as { n: number } | undefined)?.n ?? 0;
    // The importer's own admin row isn't from the file — unless the file
    // had them too, in which case it stands in for that row.
    if (spec.table === 'memberships') imported = imported - 1 + (manifest.importerInFile ? 1 : 0);
    const expected = manifest.counts[spec.table] ?? 0;
    tables[spec.table] = { expected, imported };
    if (imported !== expected) ok = false;
  });

  if (!ok) return json({ ok: false, tables }, 409);
  await env.DB.prepare('UPDATE organizations SET import_status = NULL, import_key = NULL, import_manifest = NULL WHERE id = ?').bind(orgId).run();
  return json({ ok: true, tables });
}

async function abortImport(request: Request, env: Env, orgId: string): Promise<Response> {
  const auth = await authorizeAdmin(request, env, orgId);
  if (auth.error) return auth.error;
  const state = await loadImportingOrg(env, orgId);
  if (!state || state.import_status !== 'importing') return json({ error: 'Alleen een onafgewerkte import kan geannuleerd worden' }, 409);
  // Reverse foreign-key order; memberships go last (they carry the admin
  // check), then the org itself.
  const tables = EXPORT_TABLES.map((s) => s.table).filter((t) => t !== 'memberships').reverse();
  await env.DB.batch([
    ...tables.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE org_id = ?`).bind(orgId)),
    env.DB.prepare('DELETE FROM memberships WHERE org_id = ?').bind(orgId),
    env.DB.prepare('DELETE FROM organizations WHERE id = ?').bind(orgId),
  ]);
  return json({ ok: true });
}

// Handles the export/import routes above; null for anything else.
export async function dispatchOrgTransferRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname === '/organizations/import/start' && request.method === 'POST') return startImport(request, env);
  const exportMatch = pathname.match(/^\/organizations\/([^/]+)\/export$/);
  if (exportMatch && request.method === 'GET') return exportOrg(request, env, exportMatch[1]);
  const importMatch = pathname.match(/^\/organizations\/([^/]+)\/import\/(chunk|finish|abort)$/);
  if (importMatch && request.method === 'POST') {
    const [, orgId, step] = importMatch;
    if (step === 'chunk') return importChunk(request, env, orgId);
    if (step === 'finish') return finishImport(request, env, orgId);
    return abortImport(request, env, orgId);
  }
  return null;
}
