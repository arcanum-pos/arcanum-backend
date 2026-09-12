const BASE_URLS = {
  preprod: 'https://merchant.api.preprod.bancontact.net',
  prod: 'https://merchant.api.bancontact.net',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function bancontactHeaders(env) {
  const authValue = env.AUTH_SCHEME ? `${env.AUTH_SCHEME} ${env.API_KEY}` : env.API_KEY;
  return {
    'Content-Type': 'application/json',
    Authorization: authValue,
  };
}

async function createPayment(request, env) {
  const baseUrl = BASE_URLS[env.BANCONTACT_ENVIRONMENT];
  const body = await request.json().catch(() => ({}));
  const amountCents = Number(body.amount);

  if (!Number.isInteger(amountCents) || amountCents < 1) {
    return json({ error: 'amount (in cents, integer) is required' }, 400);
  }

  const payload = { amount: amountCents, currency: 'EUR' };
  if (body.description) payload.description = String(body.description).slice(0, 140);
  if (body.reference) payload.reference = String(body.reference).slice(0, 35);

  const response = await fetch(`${baseUrl}/v3/payments`, {
    method: 'POST',
    headers: bancontactHeaders(env),
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return json({ error: 'Bancontact API error', details: data }, response.status);
  }

  return json(
    {
      paymentId: data.paymentId,
      status: data.status,
      createdAt: data.createdAt,
      expiresAt: data.expiresAt,
      amount: data.amount,
      currency: data.currency,
      qrCodeUrl: data._links?.qrcode?.href,
      deeplinkUrl: data._links?.deeplink?.href,
      selfUrl: data._links?.self?.href,
    },
    201
  );
}

const SETTINGS_DEFAULTS = {
  amountPerBonCents: 100,
  fietstochtMemberCents: 600,
  fietstochtNonMemberCents: 800,
  wandeltochtMemberCents: 400,
  wandeltochtNonMemberCents: 600,
};

async function getSettings(env) {
  const keys = Object.keys(SETTINGS_DEFAULTS);
  const stored = await Promise.all(keys.map((key) => env.SETTINGS.get(key)));

  const settings = {};
  keys.forEach((key, i) => {
    settings[key] = stored[i] ? Number(stored[i]) : SETTINGS_DEFAULTS[key];
  });

  return json(settings);
}

async function checkRateLimit(request, env) {
  if (!env.AUTH_RATE_LIMITER) return true;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.AUTH_RATE_LIMITER.limit({ key: ip });
  return success;
}

async function updateSettings(request, env) {
  if (!(await checkRateLimit(request, env))) {
    return json({ error: 'Te veel pogingen, probeer over een minuut opnieuw.' }, 429);
  }

  const body = await request.json().catch(() => ({}));
  const { password } = body;

  if (!env.SETTINGS_PASSWORD || password !== env.SETTINGS_PASSWORD) {
    return json({ error: 'Onjuist wachtwoord' }, 401);
  }

  const keys = Object.keys(SETTINGS_DEFAULTS);
  const cents = {};
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

async function verifyPassword(request, env) {
  if (!(await checkRateLimit(request, env))) {
    return json({ error: 'Te veel pogingen, probeer over een minuut opnieuw.' }, 429);
  }

  const body = await request.json().catch(() => ({}));
  if (!env.SETTINGS_PASSWORD || body.password !== env.SETTINGS_PASSWORD) {
    return json({ error: 'Onjuist wachtwoord' }, 401);
  }
  return json({ ok: true });
}

// --- SumUp bridge ---
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

function requireBridgeToken(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(env.SUMUP_BRIDGE_TOKEN) && token === env.SUMUP_BRIDGE_TOKEN;
}

// All requests go to the same singleton instance — there's only ever one
// active charge at a time in practice (one cashier terminal), so a single
// shared coordinator is simpler than trying to route by charge id.
function getSumupCoordinator(env) {
  const id = env.SUMUP_COORDINATOR.idFromName('singleton');
  return env.SUMUP_COORDINATOR.get(id);
}

async function forwardToCoordinator(env, path, init) {
  const stub = getSumupCoordinator(env);
  const response = await stub.fetch(`https://sumup-coordinator${path}`, init);
  const data = await response.json().catch(() => ({}));
  return json(data, response.status);
}

async function createSumupCharge(request, env) {
  const body = await request.json().catch(() => ({}));
  const amountCents = Number(body.amount);

  if (!Number.isInteger(amountCents) || amountCents < 1) {
    return json({ error: 'amount (in cents, integer) is required' }, 400);
  }

  return forwardToCoordinator(env, '/charge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amountCents,
      description: body.description ? String(body.description).slice(0, 140) : '',
    }),
  });
}

async function getSumupPending(request, env) {
  if (!requireBridgeToken(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return forwardToCoordinator(env, '/pending', { method: 'GET' });
}

async function postSumupResult(request, env) {
  if (!requireBridgeToken(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const body = await request.json().catch(() => ({}));
  return forwardToCoordinator(env, '/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getSumupStatus(chargeId, env) {
  return forwardToCoordinator(env, `/status/${encodeURIComponent(chargeId)}`, { method: 'GET' });
}

const SUMUP_CHARGE_TTL_MS = 5 * 60 * 1000; // abandoned charges clean themselves up after 5 min

export class SumupChargeCoordinator {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
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

  async createCharge(request) {
    const { amountCents, description } = await request.json();
    const chargeId = crypto.randomUUID();

    await this.storage.put(`charge:${chargeId}`, {
      status: 'pending',
      amountCents,
      description: description || '',
      createdAt: Date.now(),
    });

    return json({ chargeId }, 201);
  }

  async getPending() {
    await this.expireStale();

    const charges = await this.storage.list({ prefix: 'charge:' });
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

  async postResult(request) {
    const { chargeId, success, transactionCode, errorMessage } = await request.json();
    if (!chargeId) return json({ error: 'chargeId is required' }, 400);

    const key = `charge:${chargeId}`;
    const record = await this.storage.get(key);
    if (!record) return json({ error: 'Unknown chargeId' }, 404);

    record.status = success ? 'succeeded' : 'failed';
    record.transactionCode = transactionCode ? String(transactionCode) : null;
    record.errorMessage = errorMessage ? String(errorMessage).slice(0, 200) : null;
    record.resolvedAt = Date.now();

    await this.storage.put(key, record);
    return json({ ok: true });
  }

  async getStatus(chargeId) {
    const record = await this.storage.get(`charge:${chargeId}`);
    if (!record) return json({ error: 'Unknown chargeId' }, 404);

    return json({
      status: record.status,
      amountCents: record.amountCents,
      transactionCode: record.transactionCode || null,
      errorMessage: record.errorMessage || null,
    });
  }

  async expireStale() {
    const cutoff = Date.now() - SUMUP_CHARGE_TTL_MS;
    const charges = await this.storage.list({ prefix: 'charge:' });
    for (const [key, record] of charges) {
      if (record.createdAt < cutoff) {
        await this.storage.delete(key);
      }
    }
  }
}

async function getPayment(paymentId, env) {
  const baseUrl = BASE_URLS[env.BANCONTACT_ENVIRONMENT];

  const response = await fetch(`${baseUrl}/v3/payments/${paymentId}`, {
    method: 'GET',
    headers: bancontactHeaders(env),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return json({ error: 'Bancontact API error', details: data }, response.status);
  }

  return json({
    paymentId: data.paymentId,
    status: data.status,
    succeededAt: data.succeededAt,
    expireAt: data.expireAt,
    amount: data.amount,
    currency: data.currency,
  });
}

export default {
  async fetch(request, env) {
    if (!BASE_URLS[env.BANCONTACT_ENVIRONMENT]) {
      return json({ error: 'Worker misconfigured: BANCONTACT_ENVIRONMENT must be "preprod" or "prod"' }, 500);
    }
    if (!env.API_KEY) {
      return json({ error: 'Worker misconfigured: API_KEY secret is not set' }, 500);
    }

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
        return await getPayment(match[1], env);
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

      const sumupStatusMatch = url.pathname.match(/^\/sumup\/status\/([^/]+)$/);
      if (request.method === 'GET' && sumupStatusMatch) {
        return await getSumupStatus(sumupStatusMatch[1], env);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'Unexpected worker error', details: err.message }, 502);
    }
  },
};
