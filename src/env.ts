export interface Env {
  AUTH_SCHEME?: string;
  SETTINGS: KVNamespace;
  AUTH_RATE_LIMITER?: RateLimit;
  SETTINGS_PASSWORD?: string;
  CHARGE_POLLER: DurableObjectNamespace;
  DB: D1Database;
  // questo-devicehub (separate Worker) — see devicehub-client.ts.
  INTERNAL_API_KEY: string;
  DEVICEHUB_SERVICE: Fetcher;
  DEVICEHUB_LOCAL_URL?: string;
  // Platform-wide key-encryption-key — wraps each organization's own data
  // key (envelope encryption). See organizations/crypto.ts.
  ENCRYPTION_KEY: string;
  // This Worker's own publicly reachable base URL, reached through the BFF
  // — used to build the callbackUrl/return_url handed to Bancontact/SumUp
  // at charge creation (see payments/bancontact.ts, payments/sumup.ts).
  PUBLIC_BASE_URL: string;
  // Seeds the platform-default identity provider (the fallback used by any
  // org that hasn't configured its own, and by the very first bootstrap
  // admin before any org exists) — see organizations/idp-resolution.ts
  // `ensureDefaultOrganization`. Consumed only once, at first seed; safe to
  // remove afterward. Not readable back once set (Worker secrets are
  // write-only) — source these from the identity provider's own dashboard,
  // never from a previously-set Cloudflare secret.
  DEFAULT_IDP_ISSUER_URL?: string;
  DEFAULT_IDP_CLIENT_ID?: string;
  DEFAULT_IDP_CLIENT_SECRET?: string;
  // Optional provider-specific passthrough (e.g. Auth0's `connection` param
  // to force a specific enterprise connection) — most providers leave this
  // unset.
  DEFAULT_IDP_CONNECTION_NAME?: string;
}
