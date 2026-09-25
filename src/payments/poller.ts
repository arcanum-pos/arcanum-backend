// Safety-belt for missed callbacks — NOT the primary resolution path for
// SumUp or Bancontact charges (their own webhooks are, see sumup.ts's
// postSumupCallback and bancontact.ts's postBancontactCallback). Every 30s,
// asks each provider for the latest status on anything still 'pending' in
// the shared `charges` table, and force-fails anything past its own or the
// platform's default expiry (see charges.ts's expireStaleCharges) — that
// second part is the actual guarantee that nothing waits forever, since
// neither provider's docs confirm a callback fires for a silently expired
// checkout.
//
// This used to be SumupChargeCoordinator, the iOS SumUp Air bridge's entry
// point (a polling queue the bridge claimed charges from). That bridge is
// retired — a specific Solo reader is targeted directly now — so this DO
// holds no charge data of its own anymore; all of it lives in D1. Renamed
// via a `renamed_classes` migration (see wrangler.jsonc) rather than a
// fresh class, since no in-flight DO storage needs preserving anyway (the
// app isn't in live use between events) but it's the correct way to do this
// regardless.
import type { Env } from '../env';
import { expireStaleCharges, listPendingChargesForPolling, resolveCharge, type ChargeRecord } from './charges';
import { getSumupReaderCheckoutStatus } from './sumup-cloud-api';
import { getDecryptedPaymentCredential } from '../organizations/payment-credentials';
import { getBancontactPaymentStatus, BANCONTACT_TERMINAL_STATUSES } from './bancontact';

const POLL_INTERVAL_MS = 30 * 1000;
// A backlog (more stale charges than one run may handle) is worked off at this pace.
const BACKLOG_INTERVAL_MS = 1000;

// D1 on the Workers Free plan allows 50 queries per invocation — an alarm
// run included. Each step below is only started if its worst case still
// fits: expiring a charge ≈ 8 queries (resolve + ledger + tab settle),
// polling one ≈ 10 (credentials + a possible resolve). Whatever doesn't fit
// waits for the next run.
const QUERY_BUDGET = 40;
const EXPIRE_COST = 8;
const POLL_COST = 10;

export interface SweepResult {
  expired: number;
  polled: number;
  // True when stale charges are left over: run again soon.
  backlog: boolean;
  // Where the next run's polling continues (rotates through a large backlog).
  cursor: string;
}

export async function sweepCharges(env: Env, cursor = ''): Promise<SweepResult> {
  let used = 2; // the two list queries below
  const expireLimit = Math.max(0, Math.floor((QUERY_BUDGET - used) / EXPIRE_COST));
  const { expired, more } = await expireStaleCharges(env, expireLimit);
  used += expired * EXPIRE_COST;

  const pollLimit = Math.max(0, Math.floor((QUERY_BUDGET - used) / POLL_COST));
  let polled = 0;
  let next = cursor;
  if (pollLimit > 0) {
    let pending = await listPendingChargesForPolling(env, cursor, pollLimit);
    if (pending.length === 0 && cursor) pending = await listPendingChargesForPolling(env, '', pollLimit); // wrap around
    for (const charge of pending) {
      try {
        await pollCharge(env, charge);
      } catch (err) {
        // A transient error polling one charge shouldn't stop the sweep —
        // just try it again next tick.
        console.error(`Kon status niet pollen voor charge ${charge.id}`, err);
      }
      polled++;
      next = charge.id;
    }
    if (pending.length < pollLimit) next = '';
  }
  return { expired, polled, backlog: more, cursor: next };
}

export class ChargePoller implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  // In memory only — losing it just restarts the rotation from the start.
  private cursor = '';

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // The only externally-reachable entry point — pokes the alarm into
  // existence if nothing has scheduled one yet. Called right after a charge
  // is dispatched to a provider (see ensureChargePolling below); harmless
  // and idempotent if called with one already pending.
  async fetch(): Promise<Response> {
    const current = await this.state.storage.getAlarm();
    if (current === null) {
      await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    const result = await sweepCharges(this.env, this.cursor);
    this.cursor = result.cursor;
    if (result.backlog) {
      await this.state.storage.setAlarm(Date.now() + BACKLOG_INTERVAL_MS);
      return;
    }
    const remaining = await listPendingChargesForPolling(this.env, '', 1);
    if (remaining.length > 0) {
      await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }
}

async function pollCharge(env: Env, charge: ChargeRecord): Promise<void> {
  if (charge.method === 'sumup') await pollSumup(env, charge);
  else if (charge.method === 'bancontact') await pollBancontact(env, charge);
}

async function pollSumup(env: Env, charge: ChargeRecord): Promise<void> {
  const readerId = (charge.providerData as { readerId?: string }).readerId;
  if (!charge.providerRef || !readerId) return;

  const credential = await getDecryptedPaymentCredential(env, charge.orgId, 'sumup');
  const merchantId = credential?.merchantId ? String(credential.merchantId) : '';
  const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
  if (!merchantId || !apiKey) return;

  const result = await getSumupReaderCheckoutStatus({ merchantCode: merchantId, apiKey, readerId, checkoutId: charge.providerRef });
  if (result.status === 'pending') return;

  await resolveCharge(env, charge.id, {
    success: result.status === 'successful',
    providerStatus: result.status,
    errorMessage: result.paymentFailureReason,
  });
}

async function pollBancontact(env: Env, charge: ChargeRecord): Promise<void> {
  if (!charge.providerRef) return;

  const result = await getBancontactPaymentStatus(env, charge.orgId, charge.providerRef);
  if (!result || !BANCONTACT_TERMINAL_STATUSES.has(result.status)) return;

  await resolveCharge(env, charge.id, {
    success: result.status === 'SUCCEEDED',
    providerStatus: result.status,
  });
}
