// Device identity/linking and the live WebSocket relay live in a separate
// Worker (arcanum-devicehub) — kept apart from payment processing on purpose.
// This module only ever asks it to broadcast an event; it carries no
// business data, same as before.
import { waitUntil } from 'cloudflare:workers';
import type { Env } from './env';

function internalKeyHeader(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.INTERNAL_API_KEY}` };
}

export async function callDeviceHub(env: Env, path: string, init: RequestInit): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    ...internalKeyHeader(env),
    ...((init.headers as Record<string, string>) || {}),
  };

  if (env.DEVICEHUB_LOCAL_URL) {
    return fetch(`${env.DEVICEHUB_LOCAL_URL}${path}`, { ...init, headers });
  }
  return env.ARCANUM_DEVICEHUB_SERVICE.fetch(`https://devicehub${path}`, { ...init, headers });
}

// Pushes a payment/reset event to the POS itself, plus whichever CFD/sim are
// currently linked to it — devicehub resolves the "who's linked" lookup.
export async function broadcastPaymentEvent(
  env: Env,
  posTerminalId: string,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await callDeviceHub(env, '/devices/broadcast', {
      method: 'POST',
      body: JSON.stringify({ pos_terminal_id: posTerminalId, event, payload }),
    });
  } catch (err) {
    // A notification failure must never fail the payment request itself —
    // worst case, the POS/CFD/sim falls back to noticing on next interaction.
    console.error('Kon devicehub niet bereiken voor melding', err);
  }
}

// Pushes an event to every connected device of one role across a whole org
// (devicehub tags each socket with its org + role) — for things that belong
// to the org rather than to one POS, like tabs. Best-effort, same as above.
export async function broadcastOrgEvent(
  env: Env,
  orgId: string,
  event: string,
  payload: Record<string, unknown>,
  role: 'pos' | 'cfd' | 'station' = 'pos'
): Promise<void> {
  try {
    const res = await callDeviceHub(env, '/devices/broadcast-org', {
      method: 'POST',
      body: JSON.stringify({ org_id: orgId, role, event, payload }),
    });
    if (!res.ok) console.error(`devicehub weigerde melding ${event}: ${res.status}`);
  } catch (err) {
    console.error('Kon devicehub niet bereiken voor melding', err);
  }
}

// After any change to a tab (its lines, name, split, a payment, a prep
// ticket's status, a cancellation): one call to devicehub, which tells
// every kassa and station screen of the org (`tabs_changed { tab_id }`) and
// every "follow your order" page following one of these tabs
// (`order_updated`, the order hub) — so they reload it instead of waiting.
// Not awaited: handed to waitUntil, so the push adds no latency to the
// request that caused it and still completes after the response is sent.
export function notifyTabChanged(env: Env, orgId: string, tabId: string): void {
  notifyTabsChanged(env, orgId, [tabId]);
}

export function notifyTabsChanged(env: Env, orgId: string, tabIds: string[]): void {
  const push = (async () => {
    try {
      const res = await callDeviceHub(env, '/devices/tabs-changed', { method: 'POST', body: JSON.stringify({ org_id: orgId, tab_ids: tabIds }) });
      if (!res.ok) console.error(`devicehub weigerde tabs-changed: ${res.status}`);
    } catch (err) {
      console.error('Kon devicehub niet bereiken voor melding', err);
    }
  })();
  try {
    waitUntil(push);
  } catch {
    // Outside a request context: the push still runs, just unguarded.
  }
}

// A signed, short-lived ticket that admits one "follow your order" page
// into devicehub's order hub, for this one tab (self-order.ts). Null when
// devicehub can't be reached — the page then still shows the status, just
// without live updates until it's reloaded.
export async function orderHubTicket(env: Env, orgId: string, tabId: string): Promise<string | null> {
  try {
    const res = await callDeviceHub(env, '/orders/ticket', { method: 'POST', body: JSON.stringify({ org_id: orgId, tab_id: tabId }) });
    if (!res.ok) return null;
    return ((await res.json()) as { ticket?: string }).ticket ?? null;
  } catch {
    return null;
  }
}
