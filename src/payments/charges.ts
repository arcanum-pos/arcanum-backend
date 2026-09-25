// Unified in-flight payment tracking, shared by cash, SumUp, and Bancontact
// — see the comment on the `charges` table in schema.sql for why this
// replaced SumUp's dedicated Durable Object and Bancontact's total lack of
// server-side tracking. resolveCharge() is the one place a charge leaves
// 'pending' — a plain D1 UPDATE...WHERE status='pending' is atomic (D1 is a
// single-writer SQLite instance, not eventually consistent like KV), so a
// callback and the poller racing to resolve the same charge is safe without
// needing a Durable Object for coordination.
import type { Env } from '../env';
import { broadcastPaymentEvent } from '../devicehub-client';
import { recordChargeTransaction } from '../transactions';
import { settleTab } from '../tabs';

export type ChargeMethod = 'cash' | 'sumup' | 'bancontact';
export type ChargeStatus = 'pending' | 'succeeded' | 'failed';

export interface ChargeRecord {
  id: string;
  orgId: string;
  method: ChargeMethod;
  status: ChargeStatus;
  providerStatus: string | null;
  amountCents: number;
  description: string;
  posTerminalId: string | null;
  items: Record<string, unknown>;
  slotId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  userName: string | null;
  userEmail: string | null;
  createdAt: string;
  resolvedAt: string | null;
  transactionCode: string | null;
  errorMessage: string | null;
  providerRef: string | null;
  providerData: Record<string, unknown>;
  expiresAt: string | null;
  tabId: string | null;
}

interface ChargeRow {
  id: string;
  org_id: string;
  method: string;
  status: string;
  provider_status: string | null;
  amount_cents: number;
  description: string | null;
  pos_terminal_id: string | null;
  items: string | null;
  slot_id: string | null;
  device_id: string | null;
  device_name: string | null;
  user_name: string | null;
  user_email: string | null;
  created_at: string;
  resolved_at: string | null;
  transaction_code: string | null;
  error_message: string | null;
  provider_ref: string | null;
  provider_data: string | null;
  expires_at: string | null;
  tab_id: string | null;
}

function rowToCharge(row: ChargeRow): ChargeRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    method: row.method as ChargeMethod,
    status: row.status as ChargeStatus,
    providerStatus: row.provider_status,
    amountCents: row.amount_cents,
    description: row.description || '',
    posTerminalId: row.pos_terminal_id,
    items: row.items ? JSON.parse(row.items) : {},
    slotId: row.slot_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    userName: row.user_name,
    userEmail: row.user_email,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    transactionCode: row.transaction_code,
    errorMessage: row.error_message,
    providerRef: row.provider_ref,
    providerData: row.provider_data ? JSON.parse(row.provider_data) : {},
    expiresAt: row.expires_at,
    tabId: row.tab_id,
  };
}

export interface CreateChargeFields {
  // Only set when the provider needs the id supplied *before* the charge is
  // created here — Bancontact requires it as `reference` in the create-
  // payment call, so that id has to exist before this insert runs. Omitted
  // (the common case, e.g. SumUp/cash) generates one as usual.
  id?: string;
  orgId: string;
  method: ChargeMethod;
  amountCents: number;
  description?: string | null;
  posTerminalId?: string | null;
  items?: Record<string, unknown> | null;
  slotId?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  providerRef?: string | null;
  providerData?: Record<string, unknown> | null;
  expiresAt?: string | null;
  // The tab this charge settles — see tabs.ts. At most one pending charge
  // per tab (idx_charges_one_pending_per_tab): a second insert throws, see
  // tabs.ts's isPendingTabChargeConflict.
  tabId?: string | null;
}

export async function createCharge(env: Env, fields: CreateChargeFields): Promise<ChargeRecord> {
  // Hyphens stripped — Bancontact's `reference` field (its id is often this
  // one, see bancontact.ts) has a hard 35-char limit, one short of a
  // canonical UUID's 36. Stripped everywhere for consistency, not just
  // where it's currently required.
  const id = fields.id || crypto.randomUUID().replace(/-/g, '');
  const createdAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO charges
      (id, org_id, method, status, provider_status, amount_cents, description, pos_terminal_id, items, slot_id, device_id, device_name, user_name, user_email, created_at, provider_ref, provider_data, expires_at, tab_id)
     VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      fields.orgId,
      fields.method,
      fields.amountCents,
      fields.description || '',
      fields.posTerminalId || null,
      JSON.stringify(fields.items || {}),
      fields.slotId || null,
      fields.deviceId || null,
      fields.deviceName || null,
      fields.userName || null,
      fields.userEmail || null,
      createdAt,
      fields.providerRef || null,
      JSON.stringify(fields.providerData || {}),
      fields.expiresAt || null,
      fields.tabId || null
    )
    .run();

  return (await getCharge(env, id)) as ChargeRecord;
}

export async function getCharge(env: Env, id: string): Promise<ChargeRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM charges WHERE id = ?').bind(id).first<ChargeRow>();
  return row ? rowToCharge(row) : null;
}

// Called once a provider dispatch succeeds (SumUp's checkout created), to
// attach the provider's own reference after the row already exists — kept
// separate from createCharge so a dispatch failure can still leave the row
// behind (as 'failed', via resolveCharge) rather than needing to roll back
// an insert.
export async function setChargeProviderRef(
  env: Env,
  id: string,
  providerRef: string,
  providerData: Record<string, unknown>
): Promise<void> {
  await env.DB.prepare('UPDATE charges SET provider_ref = ?, provider_data = ? WHERE id = ?')
    .bind(providerRef, JSON.stringify(providerData), id)
    .run();
}

// For a provider with richer in-flight states than pending/succeeded/failed
// (Bancontact's IDENTIFIED/AUTHORIZED/...) — updates the display-only raw
// status and pushes payment_updated without resolving the charge. A no-op
// once the charge is no longer 'pending' (avoids clobbering provider_status
// after resolveCharge already set its own final value, and avoids a
// redundant push after the CFD/POS already saw the resolution).
export async function updateChargeProviderStatus(env: Env, id: string, providerStatus: string): Promise<void> {
  const result = await env.DB.prepare(`UPDATE charges SET provider_status = ? WHERE id = ? AND status = 'pending'`)
    .bind(providerStatus, id)
    .run();
  if ((result.meta.changes || 0) === 0) return;

  const record = await getCharge(env, id);
  if (record?.posTerminalId) {
    await broadcastPaymentEvent(env, record.posTerminalId, 'payment_updated', { payment_id: id, method: record.method });
  }
}

export interface ResolveOutcome {
  success: boolean;
  providerStatus?: string | null;
  transactionCode?: string | null;
  errorMessage?: string | null;
}

export interface ResolveResult {
  record: ChargeRecord;
  alreadyResolved: boolean;
}

// The one place a charge transitions out of 'pending'. Atomic — only the
// first caller (a manual confirm, a provider callback, or the poller, any
// of which can race the others) actually changes anything; everyone else
// gets alreadyResolved: true and the untouched record back. Side effects
// (notifying a linked CFD/sim, recording the sale) only fire for the
// genuine transition, never on a race loser.
export async function resolveCharge(env: Env, id: string, outcome: ResolveOutcome): Promise<ResolveResult | null> {
  const status: ChargeStatus = outcome.success ? 'succeeded' : 'failed';
  const resolvedAt = new Date().toISOString();

  const result = await env.DB.prepare(
    `UPDATE charges SET status = ?, provider_status = ?, transaction_code = ?, error_message = ?, resolved_at = ?
     WHERE id = ? AND status = 'pending'`
  )
    .bind(
      status,
      outcome.providerStatus ?? null,
      outcome.transactionCode ?? null,
      outcome.errorMessage ? outcome.errorMessage.slice(0, 200) : null,
      resolvedAt,
      id
    )
    .run();

  const record = await getCharge(env, id);
  if (!record) return null;

  const alreadyResolved = (result.meta.changes || 0) === 0;

  if (!alreadyResolved) {
    if (record.posTerminalId) {
      await broadcastPaymentEvent(env, record.posTerminalId, 'payment_updated', { payment_id: id, method: record.method });
    }
    if (record.status === 'succeeded') {
      await recordChargeTransaction(env, record);
      if (record.tabId) await settleTab(env, record.tabId);
    }
  }

  return { record, alreadyResolved };
}

// How long a charge with no provider-supplied expiry is allowed to sit
// 'pending' before the poller force-fails it regardless of what (if
// anything) the provider ever says. Matches the TTL the old SumUp DO used.
const DEFAULT_CHARGE_TTL_MS = 5 * 60 * 1000;

// The actual guarantee that nothing stays 'pending' forever — neither
// provider's docs confirm a callback fires for an expired/abandoned
// checkout, so this doesn't wait to be told; it just stops waiting.
export async function expireStaleCharges(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const defaultCutoff = new Date(Date.now() - DEFAULT_CHARGE_TTL_MS).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT id FROM charges WHERE status = 'pending' AND (
       (expires_at IS NOT NULL AND expires_at < ?) OR
       (expires_at IS NULL AND created_at < ?)
     )`
  )
    .bind(now, defaultCutoff)
    .all<{ id: string }>();

  for (const { id } of results || []) {
    await resolveCharge(env, id, { success: false, providerStatus: 'TIMED_OUT', errorMessage: 'Betaling verlopen (time-out)' });
  }
}

// What the ChargePoller DO's alarm sweeps — only charges actually dispatched
// to a provider (cash, and a sumup charge with no reader linked, have
// nothing to poll; they're only ever resolved by manual confirm or the
// time-out backstop above).
export async function listPendingChargesForPolling(env: Env): Promise<ChargeRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM charges WHERE status = 'pending' AND method IN ('sumup', 'bancontact') AND provider_ref IS NOT NULL`
  ).all<ChargeRow>();
  return (results || []).map(rowToCharge);
}
