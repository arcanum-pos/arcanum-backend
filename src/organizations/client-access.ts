// Who may sign in to this installation at its login provider — for a
// provider with restricted clients (arcanum-auth, login.kaboutersoft.be):
// only people assigned to the installation's client get in. This
// installation assigns whoever it invites (or imports) — an admin of any of
// its organisations, or on its own admin list (INSTANCE_ADMIN_EMAILS), as an
// admin of the client, who then decides on access requests too — and unassigns an address once it has no membership here
// any more. Only when the provider
// advertises it (`client_users_endpoint` in its discovery document) and the
// installer gave this Worker the client's id and secret; any other provider
// is left alone.
//
// Best effort, like the invite mail: a failure is logged, never fails the
// invite or removal. syncAllMembers (from the console's landing list, at
// most every few hours per isolate) assigns every address with a
// membership again, so a missed call heals by itself — and members from
// before this existed get assigned.
import type { Env } from '../env';
import { resolveInstanceIssuerUrl } from './idp-resolution';
import { instanceAdminAddresses } from './instance-admins';

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
// The provider takes up to 500 addresses at once.
const BULK = 500;
// Free plan: 50 subrequests per invocation — leave room for the rest.
const MAX_UNASSIGN = 40;

const discoveryCache = new Map<string, { fetchedAt: number; endpoint: string | null }>();
let lastSync = 0;

interface Target {
  endpoint: string;
  authorization: string;
}

async function usersEndpoint(env: Env): Promise<Target | null> {
  const issuer = await resolveInstanceIssuerUrl(env);
  const id = env.DEFAULT_IDP_CLIENT_ID?.trim();
  const secret = env.DEFAULT_IDP_CLIENT_SECRET?.trim();
  if (!issuer || !id || !secret) return null;
  let cached = discoveryCache.get(issuer);
  if (!cached || Date.now() - cached.fetchedAt > DISCOVERY_TTL_MS) {
    const res = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const doc = res.ok ? ((await res.json().catch(() => null)) as { client_users_endpoint?: unknown } | null) : null;
    const endpoint = typeof doc?.client_users_endpoint === 'string' && doc.client_users_endpoint.startsWith('https://') ? doc.client_users_endpoint : null;
    cached = { fetchedAt: Date.now(), endpoint };
    discoveryCache.set(issuer, cached);
  }
  if (!cached.endpoint) return null;
  return { endpoint: cached.endpoint, authorization: `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}` };
}

async function call(target: Target, path: string, init: RequestInit): Promise<void> {
  const res = await fetch(`${target.endpoint}${path}`, {
    ...init,
    headers: { Authorization: target.authorization, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`login provider ${init.method} ${path || '/'}: ${res.status}`);
}

async function bestEffort(what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`client access: ${what} failed`, err);
  }
}

interface AccessUser {
  email: string;
  role: 'admin' | 'member';
}

async function assignAll(target: Target, users: AccessUser[]): Promise<void> {
  for (let i = 0; i < users.length; i += BULK) await call(target, '', { method: 'POST', body: JSON.stringify({ users: users.slice(i, i + BULK) }) });
}

// After any change to these addresses' memberships: each one that still has
// a membership here is assigned — as an admin of the client when it is an
// admin of any organisation here (it then decides on access requests too) —
// and each one without any is unassigned.
export async function syncAddresses(env: Env, emails: string[]): Promise<void> {
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return;
  await bestEffort('sync', async () => {
    const target = await usersEndpoint(env);
    if (!target) return;
    const { results } = await env.DB.prepare(
      `SELECT value AS email, (SELECT MAX(role = 'admin') FROM memberships WHERE lower(invited_email) = value) AS admin,
              EXISTS (SELECT 1 FROM memberships WHERE lower(invited_email) = value) AS present
       FROM json_each(?)`
    )
      .bind(JSON.stringify(list))
      .all<{ email: string; admin: number | null; present: number }>();
    // The installation's own admins (the installer's list) are admins, with or without a membership.
    const admins = new Set(instanceAdminAddresses(env));
    const rows = (results || []).map((r) => (admins.has(r.email) ? { ...r, admin: 1, present: 1 } : r));
    await assignAll(target, rows.filter((r) => r.present).map((r) => ({ email: r.email, role: r.admin ? 'admin' : 'member' })));
    const gone = rows.filter((r) => !r.present).map((r) => r.email);
    if (gone.length > MAX_UNASSIGN) console.error(`client access: ${gone.length} addresses to unassign, only the first ${MAX_UNASSIGN} now`);
    for (const email of gone.slice(0, MAX_UNASSIGN)) await call(target, `/${encodeURIComponent(email)}`, { method: 'DELETE' });
  });
}

// Every address with a membership, assigned again with its role
// (idempotent) — at most every SYNC_EVERY_MS per isolate.
export async function syncAllMembers(env: Env, now = Date.now()): Promise<void> {
  if (now - lastSync < SYNC_EVERY_MS) return;
  lastSync = now;
  await bestEffort('sync all', async () => {
    const target = await usersEndpoint(env);
    if (!target) return;
    const { results } = await env.DB.prepare("SELECT lower(invited_email) AS email, MAX(role = 'admin') AS admin FROM memberships GROUP BY lower(invited_email)").all<{
      email: string;
      admin: number;
    }>();
    const users = new Map((results || []).filter((r) => r.email).map((r) => [r.email, r.admin ? 'admin' : 'member'] as const));
    for (const email of instanceAdminAddresses(env)) users.set(email, 'admin');
    await assignAll(target, [...users].map(([email, role]) => ({ email, role })));
  });
}

// Tests: forget the cached discovery and the last sync.
export function resetClientAccessCache(): void {
  discoveryCache.clear();
  lastSync = 0;
}
