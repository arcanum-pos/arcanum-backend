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
}
