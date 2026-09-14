// Device identity/linking and the live WebSocket relay live in a separate
// Worker (questo-devicehub) — kept apart from payment processing on purpose.
// This module only ever asks it to broadcast an event; it carries no
// business data, same as before.
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
  return env.DEVICEHUB_SERVICE.fetch(`https://devicehub${path}`, { ...init, headers });
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
