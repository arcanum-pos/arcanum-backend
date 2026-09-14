export interface Env {
  BANCONTACT_ENVIRONMENT: 'preprod' | 'prod';
  AUTH_SCHEME?: string;
  API_KEY: string;
  SETTINGS: KVNamespace;
  AUTH_RATE_LIMITER?: RateLimit;
  SETTINGS_PASSWORD?: string;
  SUMUP_BRIDGE_TOKEN?: string;
  SUMUP_COORDINATOR: DurableObjectNamespace;
  DB: D1Database;
  // questo-devicehub (separate Worker) — see devicehub-client.ts.
  INTERNAL_API_KEY: string;
  DEVICEHUB_SERVICE: Fetcher;
  DEVICEHUB_LOCAL_URL?: string;
  // Platform-wide key-encryption-key — wraps each organization's own data
  // key (envelope encryption). See organizations/crypto.ts.
  ENCRYPTION_KEY: string;
}
