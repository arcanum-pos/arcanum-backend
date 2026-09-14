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

export class ChargePoller implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

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
    await expireStaleCharges(this.env);

    const pending = await listPendingChargesForPolling(this.env);
    for (const charge of pending) {
      try {
        if (charge.method === 'sumup') {
          await this.pollSumup(charge);
        } else if (charge.method === 'bancontact') {
          await this.pollBancontact(charge);
        }
      } catch (err) {
        // A transient error polling one charge shouldn't stop the sweep —
        // just try it again next tick.
        console.error(`Kon status niet pollen voor charge ${charge.id}`, err);
      }
    }

    const remaining = await listPendingChargesForPolling(this.env);
    if (remaining.length > 0) {
      await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  private async pollSumup(charge: ChargeRecord): Promise<void> {
    const readerId = (charge.providerData as { readerId?: string }).readerId;
    if (!charge.providerRef || !readerId) return;

    const credential = await getDecryptedPaymentCredential(this.env, charge.orgId, 'sumup');
    const merchantId = credential?.merchantId ? String(credential.merchantId) : '';
    const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
    if (!merchantId || !apiKey) return;

    const result = await getSumupReaderCheckoutStatus({ merchantCode: merchantId, apiKey, readerId, checkoutId: charge.providerRef });
    if (result.status === 'pending') return;

    await resolveCharge(this.env, charge.id, {
      success: result.status === 'successful',
      providerStatus: result.status,
      errorMessage: result.paymentFailureReason,
    });
  }

  private async pollBancontact(charge: ChargeRecord): Promise<void> {
    if (!charge.providerRef) return;

    const result = await getBancontactPaymentStatus(this.env, charge.orgId, charge.providerRef);
    if (!result || !BANCONTACT_TERMINAL_STATUSES.has(result.status)) return;

    await resolveCharge(this.env, charge.id, {
      success: result.status === 'SUCCEEDED',
      providerStatus: result.status,
    });
  }
}
