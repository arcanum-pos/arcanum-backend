// Pricing config (KV) + the shared password gate used both here and by the
// webapp's "start a new tijdvak" action. Deliberately standalone: nothing in
// payment processing reads these values back — the amount charged is always
// whatever the client sends, these are only for the frontend's own display/
// calculation. That's what makes this domain cheap to split out later if it
// ever needs to.
import type { Env } from './env';
import { json } from './http';

const SETTINGS_DEFAULTS = {
  amountPerBonCents: 100,
  fietstochtMemberCents: 600,
  fietstochtNonMemberCents: 800,
  wandeltochtMemberCents: 400,
  wandeltochtNonMemberCents: 600,
};

type SettingsKey = keyof typeof SETTINGS_DEFAULTS;

export async function getSettings(env: Env): Promise<Response> {
  const keys = Object.keys(SETTINGS_DEFAULTS) as SettingsKey[];
  const stored = await Promise.all(keys.map((key) => env.SETTINGS.get(key)));

  const settings: Record<string, number> = {};
  keys.forEach((key, i) => {
    settings[key] = stored[i] ? Number(stored[i]) : SETTINGS_DEFAULTS[key];
  });

  return json(settings);
}

async function checkRateLimit(request: Request, env: Env): Promise<boolean> {
  if (!env.AUTH_RATE_LIMITER) return true;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.AUTH_RATE_LIMITER.limit({ key: ip });
  return success;
}

export async function updateSettings(request: Request, env: Env): Promise<Response> {
  if (!(await checkRateLimit(request, env))) {
    return json({ error: 'Te veel pogingen, probeer over een minuut opnieuw.' }, 429);
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { password } = body;

  if (!env.SETTINGS_PASSWORD || password !== env.SETTINGS_PASSWORD) {
    return json({ error: 'Onjuist wachtwoord' }, 401);
  }

  const keys = Object.keys(SETTINGS_DEFAULTS) as SettingsKey[];
  const cents: Record<string, number> = {};
  for (const key of keys) {
    const value = Number(body[key]);
    if (!Number.isInteger(value) || value < 1) {
      return json({ error: `Ongeldig bedrag voor ${key}` }, 400);
    }
    cents[key] = value;
  }

  await Promise.all(keys.map((key) => env.SETTINGS.put(key, String(cents[key]))));
  return json(cents);
}

export async function verifyPassword(request: Request, env: Env): Promise<Response> {
  if (!(await checkRateLimit(request, env))) {
    return json({ error: 'Te veel pogingen, probeer over een minuut opnieuw.' }, 429);
  }

  const body = (await request.json().catch(() => ({}))) as { password?: string };
  if (!env.SETTINGS_PASSWORD || body.password !== env.SETTINGS_PASSWORD) {
    return json({ error: 'Onjuist wachtwoord' }, 401);
  }
  return json({ ok: true });
}
