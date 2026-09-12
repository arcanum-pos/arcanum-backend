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
  fietstochtCents: 800,
  wandeltochtCents: 600,
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

async function updateSettings(request, env) {
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
  const body = await request.json().catch(() => ({}));
  if (!env.SETTINGS_PASSWORD || body.password !== env.SETTINGS_PASSWORD) {
    return json({ error: 'Onjuist wachtwoord' }, 401);
  }
  return json({ ok: true });
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

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'Unexpected worker error', details: err.message }, 502);
    }
  },
};
