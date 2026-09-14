// Thin router — the actual domains live in their own modules:
//   payments/bancontact.ts, payments/sumup.ts   — payment processing
//   payments/charges.ts                          — shared in-flight payment tracking
//   payments/poller.ts                           — ChargePoller DO, fallback for missed callbacks
//   settings.ts                                  — pricing config + password gate
//   transactions.ts                              — the shared D1 sales ledger
//   devicehub-client.ts                          — outbound calls to questo-devicehub
//   organizations/                                — multi-tenant admin portal backend
// Kept as file-level modules within one deployed Worker rather than split into
// separate Workers — see the 2026-09 discussion: Settings and Transactions
// aren't coupled tightly enough to payment processing (or, for Transactions,
// coupled in a way that tolerates network failure) to justify the operational
// cost of separate deployments yet.
import type { Env } from './env';
export type { Env };

import { json, CORS_HEADERS } from './http';
import { createPayment, postBancontactCallback } from './payments/bancontact';
import { createSumupCharge, postSumupCallback, confirmChargeFromPos, getSumupStatus, listSumupReadersForOrg } from './payments/sumup';
import { ChargePoller } from './payments/poller';
import { getSettings, updateSettings, verifyPassword } from './settings';
import { createTransaction, listTransactions } from './transactions';
import { dispatchOrganizationsRoute } from './organizations/router';

// Durable Object classes must be a named export of the Worker's main entry
// file — re-exported here since it actually lives in payments/poller.ts.
export { ChargePoller };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === 'POST' && url.pathname === '/payments') {
        return await createPayment(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/settings') {
        return await getSettings(env);
      }

      if (request.method === 'POST' && url.pathname === '/settings') {
        return await updateSettings(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/verify-password') {
        return await verifyPassword(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/sumup/charge') {
        return await createSumupCharge(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/sumup/confirm') {
        return await confirmChargeFromPos(request, env);
      }

      const sumupStatusMatch = url.pathname.match(/^\/sumup\/status\/([^/]+)$/);
      if (request.method === 'GET' && sumupStatusMatch) {
        return await getSumupStatus(sumupStatusMatch[1], env);
      }

      if (request.method === 'GET' && url.pathname === '/sumup/readers') {
        return await listSumupReadersForOrg(request, env);
      }

      // Payment-provider webhook callbacks — reached via the BFF's
      // unauthenticated /api/callback/* passthrough (see questo-bff's
      // router.ts), never called directly by a browser. Each verifies its
      // own authenticity (SumUp: a per-charge token embedded in the URL;
      // Bancontact: a JWS signature) rather than relying on this being
      // unauthenticated-by-design at the BFF layer alone.
      const sumupCallbackMatch = url.pathname.match(/^\/callback\/sumup\/([^/]+)\/([^/]+)$/);
      if (request.method === 'POST' && sumupCallbackMatch) {
        return await postSumupCallback(request, env, sumupCallbackMatch[1], sumupCallbackMatch[2]);
      }

      if (request.method === 'POST' && url.pathname === '/callback/bancontact') {
        return await postBancontactCallback(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/transactions') {
        return await createTransaction(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/transactions') {
        return await listTransactions(request, env);
      }

      if (url.pathname.startsWith('/organizations')) {
        const response = await dispatchOrganizationsRoute(request, env, url.pathname);
        if (response) return response;
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'Unexpected worker error', details: (err as Error).message }, 502);
    }
  },
};
