// Thin router — the actual domains live in their own modules:
//   payments/bancontact.ts, payments/sumup.ts   — payment processing
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
import { createPayment, getPayment } from './payments/bancontact';
import {
  createSumupCharge,
  getSumupPending,
  postSumupResult,
  confirmChargeFromPos,
  getSumupStatus,
  listSumupReadersForOrg,
  SumupChargeCoordinator,
} from './payments/sumup';
import { getSettings, updateSettings, verifyPassword } from './settings';
import { createTransaction, listTransactions } from './transactions';
import { dispatchOrganizationsRoute } from './organizations/router';

// Durable Object classes must be a named export of the Worker's main entry
// file — re-exported here since it actually lives in payments/sumup.ts.
export { SumupChargeCoordinator };

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

      const match = url.pathname.match(/^\/payments\/([^/]+)$/);
      if (request.method === 'GET' && match) {
        return await getPayment(match[1], url.searchParams.get('org_id'), env);
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

      if (request.method === 'GET' && url.pathname === '/sumup/pending') {
        return await getSumupPending(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/sumup/result') {
        return await postSumupResult(request, env);
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
