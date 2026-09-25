// Shared test helpers. Every test seeds its own org with random ids, so
// tests never depend on each other or on a clean database.
import { env, SELF } from 'cloudflare:test';
import { generateDataKey, wrapDataKey } from '../src/organizations/crypto';

export interface TestUser {
  sub: string;
  issuer: string;
  name: string;
  email: string;
}

export interface TestOrg {
  orgId: string;
  admin: TestUser;
  cashier: TestUser;
}

function randomId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function makeUser(label: string): TestUser {
  const sub = randomId(label);
  return { sub, issuer: 'https://issuer.test/', name: label, email: `${sub}@test` };
}

// An org with a real wrapped data key (so encrypted payment credentials
// work end to end) plus one active admin and one active cashier.
export async function seedOrg(): Promise<TestOrg> {
  const orgId = randomId('org');
  const admin = makeUser('Admin');
  const cashier = makeUser('Ann');
  const wrapped = await wrapDataKey(generateDataKey(), env.ENCRYPTION_KEY);
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare('INSERT INTO organizations (id, name, dek_ciphertext, dek_iv, created_at, created_by_sub) VALUES (?, ?, ?, ?, ?, ?)').bind(
      orgId,
      'Test org',
      wrapped.ciphertext,
      wrapped.iv,
      now,
      admin.sub
    ),
    ...[
      [admin, 'admin'],
      [cashier, 'cashier'],
    ].map(([user, role]) =>
      env.DB.prepare(
        `INSERT INTO memberships (id, org_id, user_sub, issuer, invited_email, role, status, invited_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      ).bind(crypto.randomUUID(), orgId, (user as TestUser).sub, (user as TestUser).issuer, (user as TestUser).email, role, now, now)
    ),
  ]);

  return { orgId, admin, cashier };
}

// The same identity headers arcanum-bff attaches after checking the session.
export function identityHeaders(user: TestUser): Record<string, string> {
  return { 'X-User-Sub': user.sub, 'X-User-Issuer': user.issuer, 'X-User-Name': user.name, 'X-User-Email': user.email };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

// Calls this Worker as the BFF would. `user: null` sends no identity at all.
export async function api<T = any>(method: string, path: string, options: { user?: TestUser | null; body?: unknown } = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.user) Object.assign(headers, identityHeaders(options.user));
  const res = await SELF.fetch(`https://backend.test${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export const DEVICE = { deviceId: 'device-1', deviceName: 'Toog' };

export function line(itemCode: string | null, name: string, unitPriceCents: number, quantity: number) {
  return { itemCode, name, unitPriceCents, quantity };
}

// --- Tab shortcuts ---

export function tabsPath(orgId: string, suffix = '') {
  return `/organizations/${orgId}/tabs${suffix}`;
}

export async function createTab(org: TestOrg, body: Record<string, unknown> = {}) {
  const res = await api('POST', tabsPath(org.orgId), { user: org.cashier, body: { ...DEVICE, ...body } });
  if (res.status !== 201) throw new Error(`createTab failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function getTab(org: TestOrg, tabId: string) {
  return (await api('GET', tabsPath(org.orgId, `/${tabId}`), { user: org.cashier })).body;
}

// A cash charge for a tab — cash has no provider, so it only resolves via
// /sumup/confirm (the kassa's manual confirm).
export function chargeCash(org: TestOrg, tabId: string, amount: number, extra: Record<string, unknown> = {}) {
  return api('POST', '/sumup/charge', { user: org.cashier, body: { orgId: org.orgId, method: 'cash', tabId, amount, ...DEVICE, ...extra } });
}

export function confirmCharge(org: TestOrg, chargeId: string, success = true) {
  return api('POST', '/sumup/confirm', { user: org.cashier, body: { chargeId, success } });
}

export async function payCash(org: TestOrg, tabId: string, amount: number) {
  const res = await chargeCash(org, tabId, amount);
  if (res.status !== 201) throw new Error(`charge failed: ${res.status} ${JSON.stringify(res.body)}`);
  await confirmCharge(org, res.body.chargeId, true);
  return res.body.chargeId as string;
}

// --- DB ---

export async function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql).bind(...params).all<T>();
  return results || [];
}

// Calls recorded by the stub devicehub/mailer service bindings (vitest.config.ts).
export async function recordedCalls(service: 'devicehub' | 'mailer'): Promise<{ path: string; body: any }[]> {
  const binding = service === 'devicehub' ? env.ARCANUM_DEVICEHUB_SERVICE : env.ARCANUM_MAILER_SERVICE;
  return (await binding.fetch('https://stub/__calls')).json();
}
