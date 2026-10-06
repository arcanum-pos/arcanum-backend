// Device identity/linking and the live WebSocket relay live in a separate
// Worker (arcanum-devicehub) — kept apart from payment processing on purpose.
// This module only ever asks it to broadcast an event; it carries no
// business data, same as before.
import { waitUntil } from 'cloudflare:workers';
import type { Env } from './env';

function internalKeyHeader(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.INTERNAL_API_KEY}` };
}

async function callDeviceHub(env: Env, path: string, init: RequestInit): Promise<Response> {
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
  role: 'pos' | 'cfd' = 'pos'
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

// `tabs_changed { tab_id }` to every kassa of the org, after any change to a
// tab (its lines, name, split, or a payment on it) — so another kassa
// reloads it instead of waiting for focus/switch. Not awaited: handed to
// waitUntil, so the push adds no latency to the request that caused it and
// still completes after the response is sent.
export function notifyTabChanged(env: Env, orgId: string, tabId: string): void {
  const push = broadcastOrgEvent(env, orgId, 'tabs_changed', { tab_id: tabId });
  try {
    waitUntil(push);
  } catch {
    // Outside a request context: the push still runs, just unguarded.
  }
}
