// The shared D1 sales ledger. Recorded either by the webapp directly
// (Bancontact, once its poll sees SUCCEEDED — createTransaction below) or by
// this backend itself the moment a tracked cash/SumUp charge resolves (see
// recordChargeTransaction, called from payments/sumup.ts's resolveCharge) —
// deliberately an in-process D1 call, not a network hop to a separate
// worker, since losing a sale record silently is a real problem, not a
// cosmetic one. D1 gives every device the same shared, queryable log,
// replacing what used to be per-device localStorage.
import type { Env } from './env';
import { json } from './http';

const TRANSACTION_METHODS = new Set(['cash', 'sumup', 'bancontact']);

interface TransactionFields {
  amountCents: number;
  description?: string | null;
  method: string;
  items?: Record<string, unknown> | null;
  slotId?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  orgId: string;
  completedAt?: string;
}

async function insertTransaction(env: Env, fields: TransactionFields): Promise<{ id: string; completedAt: string }> {
  const id = crypto.randomUUID();
  const completedAt = fields.completedAt ? String(fields.completedAt) : new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO transactions
      (id, amount_cents, description, method, items, slot_id, device_id, device_name, user_name, user_email, org_id, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      fields.amountCents,
      fields.description ? String(fields.description).slice(0, 200) : '',
      fields.method,
      JSON.stringify(fields.items || {}),
      fields.slotId ? String(fields.slotId) : null,
      fields.deviceId ? String(fields.deviceId) : null,
      fields.deviceName ? String(fields.deviceName) : null,
      fields.userName ? String(fields.userName) : null,
      fields.userEmail ? String(fields.userEmail) : null,
      fields.orgId,
      completedAt
    )
    .run();

  return { id, completedAt };
}

// Structurally what's needed to record a resolved charge — deliberately not
// importing payments/sumup.ts's ChargeRecord type, so this module doesn't
// depend on payment-processing's internal shapes, only on payment
// processing depending on this function (matches the "transactions is
// linked to payments, not the other way round" call direction).
export interface RecordableCharge {
  amountCents: number;
  description: string;
  method: string;
  items: Record<string, unknown>;
  slotId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  userName: string | null;
  userEmail: string | null;
  orgId: string | null;
}

export async function recordChargeTransaction(env: Env, charge: RecordableCharge): Promise<void> {
  if (!charge.orgId) {
    // Should not happen in practice (createSumupCharge requires orgId), but a
    // lost sale is worse than an unattributed one — record it rather than drop it.
    console.error('Recording a charge transaction with no orgId', charge);
  }
  await insertTransaction(env, {
    amountCents: charge.amountCents,
    description: charge.description,
    method: charge.method || 'sumup',
    items: charge.items,
    slotId: charge.slotId,
    deviceId: charge.deviceId,
    deviceName: charge.deviceName,
    userName: charge.userName,
    userEmail: charge.userEmail,
    orgId: charge.orgId || '',
  });
}

export async function createTransaction(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Partial<TransactionFields> & { amountCents?: unknown };
  const amountCents = Number(body.amountCents);
  const method = String(body.method || '');
  const orgId = body.orgId ? String(body.orgId) : '';

  if (!Number.isInteger(amountCents) || amountCents < 0) {
    return json({ error: 'amountCents (integer) is required' }, 400);
  }
  if (!TRANSACTION_METHODS.has(method)) {
    return json({ error: 'method must be cash, sumup or bancontact' }, 400);
  }
  if (!orgId) {
    return json({ error: 'orgId is required' }, 400);
  }

  const result = await insertTransaction(env, { ...body, amountCents, method, orgId });
  return json(result, 201);
}

interface TransactionRow {
  id: string;
  amount_cents: number;
  description: string | null;
  method: string;
  items: string | null;
  slot_id: string | null;
  device_id: string | null;
  device_name: string | null;
  user_name: string | null;
  user_email: string | null;
  org_id: string | null;
  completed_at: string;
}

function rowToTransaction(row: TransactionRow) {
  let items: Record<string, unknown> = {};
  try {
    items = row.items ? JSON.parse(row.items) : {};
  } catch {
    items = {};
  }
  return {
    id: row.id,
    amountCents: row.amount_cents,
    description: row.description || '',
    method: row.method,
    items,
    slotId: row.slot_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    userName: row.user_name,
    userEmail: row.user_email,
    orgId: row.org_id,
    completedAt: row.completed_at,
  };
}

export async function listTransactions(request: Request, env: Env): Promise<Response> {
  const orgId = new URL(request.url).searchParams.get('orgId');
  if (!orgId) return json({ error: 'orgId is required' }, 400);

  const { results } = await env.DB.prepare(
    'SELECT * FROM transactions WHERE org_id = ? ORDER BY completed_at DESC LIMIT 5000'
  )
    .bind(orgId)
    .all<TransactionRow>();
  return json((results || []).map(rowToTransaction));
}
