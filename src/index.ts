// Thin router — the actual domains live in their own modules:
//   payments/bancontact.ts, payments/sumup.ts   — payment processing
//   payments/charges.ts                          — shared in-flight payment tracking
//   payments/poller.ts                           — ChargePoller DO, fallback for missed callbacks
//   transactions.ts                              — the shared D1 sales ledger
//   tabs.ts                                      — tabs (rekeningen), orders, order lines
//   catalog.ts                                   — categories, products, catalogs (menukaarten)
//   catalog-import.ts                            — menukaart import/export (spreadsheet rows)
//   reports.ts                                   — sales report
//   org-transfer.ts                              — org data export / import (self-hosting move)
//   devicehub-client.ts                          — outbound calls to arcanum-devicehub
//   organizations/                                — multi-tenant admin portal backend
// Kept as file-level modules within one deployed Worker rather than split into
// separate Workers — see the 2026-09 discussion: Transactions, tabs and
// catalogs aren't coupled to payment processing in a way that tolerates
// network failure, and don't justify the operational cost of separate
// deployments yet.
import type { Env } from './env';
export type { Env };

import { json, CORS_HEADERS } from './http';
import { createPayment, postBancontactCallback } from './payments/bancontact';
import { createSumupCharge, postSumupCallback, confirmChargeFromPos, getSumupStatus, listSumupReadersForOrg } from './payments/sumup';
import { ChargePoller } from './payments/poller';
import { createTransaction, listTransactions } from './transactions';
import { dispatchOrganizationsRoute } from './organizations/router';
import { dispatchTabsRoute } from './tabs';
import { dispatchCatalogRoute } from './catalog';
import { dispatchCatalogImportRoute } from './catalog-import';
import { dispatchReportsRoute } from './reports';
import { dispatchOrgTransferRoute } from './org-transfer';

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
      // unauthenticated /api/callback/* passthrough (see arcanum-bff's
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
        // First: /organizations/import/start would otherwise be read as an org id.
        const transferResponse = await dispatchOrgTransferRoute(request, env, url.pathname);
        if (transferResponse) return transferResponse;
        // Tabs live under the org path (so they share its BFF route and
        // membership check) but aren't admin-portal code — own module.
        const tabsResponse = await dispatchTabsRoute(request, env, url.pathname);
        if (tabsResponse) return tabsResponse;
        // Before the generic catalog routes, which would read 'import' as a catalog id.
        const importResponse = await dispatchCatalogImportRoute(request, env, url.pathname);
        if (importResponse) return importResponse;
        const catalogResponse = await dispatchCatalogRoute(request, env, url.pathname);
        if (catalogResponse) return catalogResponse;
        const reportsResponse = await dispatchReportsRoute(request, env, url.pathname);
        if (reportsResponse) return reportsResponse;
        const response = await dispatchOrganizationsRoute(request, env, url.pathname);
        if (response) return response;
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'Unexpected worker error', details: (err as Error).message }, 502);
    }
  },
};
