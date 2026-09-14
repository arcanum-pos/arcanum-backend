// SumUp bridge + the generic tracked-charge coordinator cash also rides on.
//
// /sumup/charge and /sumup/status/:id are called by the webapp (via the BFF,
// same trust model as /payments). /sumup/pending and /sumup/result are called
// directly by the iOS bridge app over the internet — it can't sit behind the
// BFF's Auth0 session, so those two require a shared-secret bearer token.
//
// Charge state lives in a Durable Object (SumupChargeCoordinator, below), not
// KV: KV is only eventually consistent (up to ~60s to propagate between
// regions), which is fine for rarely-changing SETTINGS but was adding real,
// visible delay to this fast-changing coordination signal. A Durable Object
// is a single, strongly-consistent instance — no propagation lag between the
// webapp's and the iOS app's requests, wherever they connect from.
import type { Env } from '../env';
import { json } from '../http';
import { broadcastPaymentEvent } from '../devicehub-client';
import { recordChargeTransaction } from '../transactions';
import { getDecryptedPaymentCredential } from '../organizations/payment-credentials';
import {
  listSumupReaders,
  createSumupReaderCheckout,
  getSumupReaderCheckoutStatus,
  SumupCloudApiError,
} from './sumup-cloud-api';

function requireBridgeToken(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(env.SUMUP_BRIDGE_TOKEN) && token === env.SUMUP_BRIDGE_TOKEN;
}

// All requests go to the same singleton instance — there's only ever one
// active charge at a time in practice (one cashier terminal), so a single
// shared coordinator is simpler than trying to route by charge id.
function getSumupCoordinator(env: Env): DurableObjectStub {
  const id = env.SUMUP_COORDINATOR.idFromName('singleton');
  return env.SUMUP_COORDINATOR.get(id);
}

async function forwardToCoordinator(env: Env, path: string, init: RequestInit): Promise<Response> {
  const stub = getSumupCoordinator(env);
  const response = await stub.fetch(`https://sumup-coordinator${path}`, init);
  const data = await response.json().catch(() => ({}));
  return json(data, response.status);
}

interface CreateChargeBody {
  amount?: number;
  description?: string;
  posTerminalId?: string;
  method?: string;
  items?: Record<string, unknown>;
  slotId?: string;
  deviceId?: string;
  deviceName?: string;
  orgId?: string;
  // Set when this POS has a real SumUp Solo reader selected in Instellingen
  // (see settings.ts) — routes the charge through the Cloud API instead of
  // the local pending-queue flow the simulator/iOS bridge use.
  readerId?: string;
}

// Called by the settings page to populate the "SumUp Solo-readers" panel
// with the org's actual paired readers, fetched live from SumUp — nothing is
// cached locally, so a reader removed from the SumUp account just disappears
// here too on next refresh.
export async function listSumupReadersForOrg(request: Request, env: Env): Promise<Response> {
  const orgId = new URL(request.url).searchParams.get('org_id');
  if (!orgId) return json({ error: 'org_id is required' }, 400);

  const credential = await getDecryptedPaymentCredential(env, orgId, 'sumup');
  const merchantId = credential?.merchantId ? String(credential.merchantId) : '';
  const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
  if (!merchantId || !apiKey) {
    return json({ configured: false, readers: [] });
  }

  try {
    const readers = await listSumupReaders(merchantId, apiKey);
    return json({ configured: true, readers });
  } catch (err) {
    const message = err instanceof SumupCloudApiError ? err.message : 'Kon SumUp readers niet ophalen';
    return json({ configured: true, readers: [], error: message }, 502);
  }
}

export async function createSumupCharge(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as CreateChargeBody;
  const amountCents = Number(body.amount);

  if (!Number.isInteger(amountCents) || amountCents < 1) {
    return json({ error: 'amount (in cents, integer) is required' }, 400);
  }
  if (!body.orgId) {
    return json({ error: 'orgId is required' }, 400);
  }

  const posTerminalId = body.posTerminalId ? String(body.posTerminalId) : null;
  // Reused for any "manual confirm" method (cash included), not just sumup —
  // it's just a generic tracked-payment coordinator under a sumup-shaped name.
  const method = body.method ? String(body.method) : 'sumup';

  const response = await forwardToCoordinator(env, '/charge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amountCents,
      description: body.description ? String(body.description).slice(0, 140) : '',
      posTerminalId,
      method,
      items: body.items || {},
      slotId: body.slotId ? String(body.slotId) : null,
      deviceId: body.deviceId ? String(body.deviceId) : null,
      deviceName: body.deviceName ? String(body.deviceName) : null,
      orgId: String(body.orgId),
      readerId: body.readerId ? String(body.readerId) : null,
      // From the BFF's session (serviceProxy.ts's setIdentityHeaders) — not
      // from the client body, since the client could claim to be anyone.
      // Captured at creation time; see the comment in createCharge for why.
      userName: request.headers.get('X-User-Name') || null,
      userEmail: request.headers.get('X-User-Email') || null,
    }),
  });

  if (posTerminalId && response.status === 201) {
    const data = (await response.clone().json().catch(() => ({}))) as { chargeId?: string };
    if (data.chargeId) {
      await broadcastPaymentEvent(env, posTerminalId, 'payment_updated', { payment_id: data.chargeId, method });
    }
  }

  return response;
}

export async function getSumupPending(request: Request, env: Env): Promise<Response> {
  if (!requireBridgeToken(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return forwardToCoordinator(env, '/pending', { method: 'GET' });
}

export async function postSumupResult(request: Request, env: Env): Promise<Response> {
  if (!requireBridgeToken(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const body = await request.json().catch(() => ({}));
  return resolveCharge(env, body as ResolveChargeBody);
}

// Called by the webapp itself (reached via the BFF, session-checked — no bridge
// token here, unlike /sumup/result which is the iOS bridge's own path) when the
// cashier taps "confirm" on a manual cash/SumUp payment.
export async function confirmChargeFromPos(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { chargeId?: string; success?: boolean };
  if (!body.chargeId) return json({ error: 'chargeId is required' }, 400);
  return resolveCharge(env, { chargeId: body.chargeId, success: body.success !== false });
}

interface ResolveChargeBody {
  chargeId?: string;
  success?: boolean;
  transactionCode?: string;
  errorMessage?: string;
}

interface ResolvedChargeResponse extends ChargeRecord {
  ok: true;
  chargeId: string;
  alreadyResolved: boolean;
}

async function resolveCharge(env: Env, body: ResolveChargeBody): Promise<Response> {
  const response = await forwardToCoordinator(env, '/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = (await response.clone().json().catch(() => ({}))) as Partial<ResolvedChargeResponse>;
  if (data.posTerminalId && body.chargeId) {
    await broadcastPaymentEvent(env, data.posTerminalId, 'payment_updated', {
      payment_id: body.chargeId,
      method: data.method || 'sumup',
    });
  }

  // The backend, not the client, is the one that records a sale — a client
  // that's reloaded, crashed, or never gets a response must not mean the sale
  // goes unrecorded. alreadyResolved guards against double-recording when the
  // reader/bridge and a manual confirm both resolve the same charge.
  if (data.status === 'succeeded' && !data.alreadyResolved) {
    await recordChargeTransaction(env, data as ResolvedChargeResponse);
  }

  return response;
}

export async function getSumupStatus(chargeId: string, env: Env): Promise<Response> {
  return forwardToCoordinator(env, `/status/${encodeURIComponent(chargeId)}`, { method: 'GET' });
}

const SUMUP_CHARGE_TTL_MS = 5 * 60 * 1000; // abandoned charges clean themselves up after 5 min

// How often the alarm re-polls SumUp for outstanding reader checkouts. No
// callback/webhook support yet (this backend isn't reachable from the
// internet during local testing) — see createSumupReaderCheckout's comment.
// Once a return_url is wired up, this alarm becomes a fallback rather than
// the only source of truth, same plan as Bancontact Pro's callback.
const SUMUP_CLOUD_POLL_INTERVAL_MS = 2000;

interface ChargeRecord {
  // 'dispatched' = sent to a real Solo reader via the Cloud API, awaiting the
  // alarm's poll; distinct from 'claimed', which is the local bridge/simulator
  // picking a charge up off the /pending queue.
  status: 'pending' | 'claimed' | 'dispatched' | 'succeeded' | 'failed';
  amountCents: number;
  description: string;
  posTerminalId: string | null;
  method: string;
  items: Record<string, unknown>;
  slotId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  userName: string | null;
  userEmail: string | null;
  orgId: string | null;
  createdAt: number;
  claimedAt?: number;
  resolvedAt?: number;
  transactionCode?: string | null;
  errorMessage?: string | null;
  // Set only for charges dispatched to a real reader via the Cloud API.
  readerId?: string | null;
  sumupCheckoutId?: string | null;
}

// One DO instance per deployment: device counts here are small (a handful of
// POS terminals), so a single coordinator is simpler than routing by charge.
export class SumupChargeCoordinator implements DurableObject {
  private storage: DurableObjectStorage;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/charge') {
      return this.createCharge(request);
    }
    if (request.method === 'GET' && url.pathname === '/pending') {
      return this.getPending();
    }
    if (request.method === 'POST' && url.pathname === '/result') {
      return this.postResult(request);
    }
    const statusMatch = url.pathname.match(/^\/status\/([^/]+)$/);
    if (request.method === 'GET' && statusMatch) {
      return this.getStatus(decodeURIComponent(statusMatch[1]));
    }

    return json({ error: 'Not found' }, 404);
  }

  async createCharge(request: Request): Promise<Response> {
    const { amountCents, description, posTerminalId, method, items, slotId, deviceId, deviceName, userName, userEmail, orgId, readerId } =
      (await request.json()) as Partial<ChargeRecord>;
    const chargeId = crypto.randomUUID();

    // Captured now (not at resolve time) because resolution can come from the
    // iOS bridge or a bearer-token confirm with no session/identity headers
    // at all — this is the only point that's guaranteed to have them.
    const record: ChargeRecord = {
      status: 'pending',
      amountCents: amountCents as number,
      description: description || '',
      posTerminalId: posTerminalId || null,
      method: method || 'sumup',
      items: items || {},
      slotId: slotId || null,
      deviceId: deviceId || null,
      deviceName: deviceName || null,
      userName: userName || null,
      userEmail: userEmail || null,
      orgId: orgId || null,
      createdAt: Date.now(),
      readerId: readerId || null,
    };

    if (readerId) {
      await this.dispatchToReader(record);
    }

    await this.storage.put(`charge:${chargeId}`, record);
    if (record.status === 'dispatched') {
      await this.storage.setAlarm(Date.now() + SUMUP_CLOUD_POLL_INTERVAL_MS);
    }

    return json({ chargeId }, 201);
  }

  // Sends the charge straight to a real Solo reader via SumUp's Cloud API —
  // mutates `record` in place (still unsaved at this point) rather than
  // returning a new one, since createCharge needs to decide whether to also
  // schedule the poll alarm based on the outcome.
  async dispatchToReader(record: ChargeRecord): Promise<void> {
    if (!record.orgId) {
      record.status = 'failed';
      record.errorMessage = 'Geen organisatie bekend voor deze betaling';
      return;
    }

    const credential = await getDecryptedPaymentCredential(this.env, record.orgId, 'sumup');
    const merchantId = credential?.merchantId ? String(credential.merchantId) : '';
    const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
    if (!merchantId || !apiKey) {
      record.status = 'failed';
      record.errorMessage = 'SumUp cloud-API niet geconfigureerd voor deze organisatie';
      return;
    }

    try {
      const checkout = await createSumupReaderCheckout({
        merchantCode: merchantId,
        apiKey,
        readerId: record.readerId as string,
        amountCents: record.amountCents,
        currency: 'EUR',
        description: record.description,
      });
      record.status = 'dispatched';
      record.sumupCheckoutId = checkout.checkoutId;
    } catch (err) {
      record.status = 'failed';
      record.errorMessage = err instanceof SumupCloudApiError ? err.message : 'Kon betaling niet naar SumUp-reader sturen';
    }
  }

  async getPending(): Promise<Response> {
    await this.expireStale();

    const charges = await this.storage.list<ChargeRecord>({ prefix: 'charge:' });
    for (const [key, record] of charges) {
      if (record.status !== 'pending') continue;

      record.status = 'claimed';
      record.claimedAt = Date.now();
      await this.storage.put(key, record);

      return json({
        chargeId: key.slice('charge:'.length),
        amountCents: record.amountCents,
        description: record.description,
      });
    }

    return json({ chargeId: null });
  }

  async postResult(request: Request): Promise<Response> {
    const { chargeId, success, transactionCode, errorMessage } = (await request.json()) as ResolveChargeBody;
    if (!chargeId) return json({ error: 'chargeId is required' }, 400);

    const key = `charge:${chargeId}`;
    const record = await this.storage.get<ChargeRecord>(key);
    if (!record) return json({ error: 'Unknown chargeId' }, 404);

    // Guards against double-resolution (e.g. the reader/bridge and a manual
    // confirm racing) — without this, the caller would record the same sale
    // to the transaction log twice.
    const alreadyResolved = record.status !== 'pending';

    if (!alreadyResolved) {
      record.status = success ? 'succeeded' : 'failed';
      record.transactionCode = transactionCode ? String(transactionCode) : null;
      record.errorMessage = errorMessage ? String(errorMessage).slice(0, 200) : null;
      record.resolvedAt = Date.now();
      await this.storage.put(key, record);
    }

    return json({ ...record, chargeId, alreadyResolved });
  }

  async getStatus(chargeId: string): Promise<Response> {
    const record = await this.storage.get<ChargeRecord>(`charge:${chargeId}`);
    if (!record) return json({ error: 'Unknown chargeId' }, 404);

    return json({
      status: record.status,
      amountCents: record.amountCents,
      transactionCode: record.transactionCode || null,
      errorMessage: record.errorMessage || null,
      method: record.method || 'sumup',
    });
  }

  async expireStale(): Promise<void> {
    const cutoff = Date.now() - SUMUP_CHARGE_TTL_MS;
    const charges = await this.storage.list<ChargeRecord>({ prefix: 'charge:' });
    for (const [key, record] of charges) {
      if (record.createdAt < cutoff) {
        await this.storage.delete(key);
      }
    }
  }

  // Backend-driven polling for reader checkouts dispatched via the Cloud API
  // (see dispatchToReader) — the only "callback" mechanism available while
  // this worker isn't reachable from the internet. Re-arms itself as long as
  // any charge is still 'dispatched'; DO alarms don't repeat on their own.
  async alarm(): Promise<void> {
    await this.expireStale();

    const charges = await this.storage.list<ChargeRecord>({ prefix: 'charge:' });
    let stillWaiting = false;

    for (const [key, record] of charges) {
      if (record.status !== 'dispatched' || !record.sumupCheckoutId || !record.readerId || !record.orgId) continue;

      const credential = await getDecryptedPaymentCredential(this.env, record.orgId, 'sumup');
      const merchantId = credential?.merchantId ? String(credential.merchantId) : '';
      const apiKey = credential?.apiKey ? String(credential.apiKey) : '';
      if (!merchantId || !apiKey) {
        // Credentials were removed mid-flight — fail it rather than poll forever.
        record.status = 'failed';
        record.errorMessage = 'SumUp cloud-API niet meer geconfigureerd voor deze organisatie';
      } else {
        try {
          const result = await getSumupReaderCheckoutStatus({
            merchantCode: merchantId,
            apiKey,
            readerId: record.readerId,
            checkoutId: record.sumupCheckoutId,
          });

          if (result.status === 'pending') {
            stillWaiting = true;
            continue;
          }

          record.status = result.status === 'successful' ? 'succeeded' : 'failed';
          record.errorMessage = result.paymentFailureReason;
        } catch (err) {
          // A transient error polling SumUp shouldn't fail the charge — just
          // try again on the next alarm tick.
          console.error('Kon SumUp reader-checkout status niet ophalen', err);
          stillWaiting = true;
          continue;
        }
      }

      record.resolvedAt = Date.now();
      await this.storage.put(key, record);

      const chargeId = key.slice('charge:'.length);
      if (record.posTerminalId) {
        await broadcastPaymentEvent(this.env, record.posTerminalId, 'payment_updated', {
          payment_id: chargeId,
          method: record.method || 'sumup',
        });
      }
      if (record.status === 'succeeded') {
        await recordChargeTransaction(this.env, record);
      }
    }

    if (stillWaiting) {
      await this.storage.setAlarm(Date.now() + SUMUP_CLOUD_POLL_INTERVAL_MS);
    }
  }
}
