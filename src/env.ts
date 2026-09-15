export interface Env {
  AUTH_SCHEME?: string;
  SETTINGS: KVNamespace;
  AUTH_RATE_LIMITER?: RateLimit;
  SETTINGS_PASSWORD?: string;
  CHARGE_POLLER: DurableObjectNamespace;
  DB: D1Database;
  // questo-devicehub (separate Worker) — see devicehub-client.ts.
  INTERNAL_API_KEY: string;
  // questo-bff's calls to this Worker's own internal-only
  // /organizations/:orgId/identity-provider/resolve route — see
  // organizations/identity-providers.ts. Deliberately a separate secret
  // from INTERNAL_API_KEY above (a different pairwise relationship,
  // independently rotatable) — not the same value.
  BFF_INTERNAL_KEY: string;
  DEVICEHUB_SERVICE: Fetcher;
  DEVICEHUB_LOCAL_URL?: string;
  // questo-mail (separate Worker) — see mailer-client.ts. A different
  // secret from INTERNAL_API_KEY/BFF_INTERNAL_KEY above, same "one secret
  // per pairwise relationship" reasoning.
  MAILER_SERVICE: Fetcher;
  MAILER_LOCAL_URL?: string;
  MAILER_INTERNAL_KEY: string;
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
  // Seeds the platform-default SMTP account (the fallback used by any org
  // that hasn't configured its own) — see organizations/smtp-credentials.ts
  // `ensureDefaultSmtpCredentials`. Consumed only once, at first seed; safe
  // to remove afterward. A personal Gmail account + an app password works
  // fine (smtp.gmail.com, port 587).
  DEFAULT_SMTP_HOST?: string;
  DEFAULT_SMTP_PORT?: string;
  DEFAULT_SMTP_USER?: string;
  DEFAULT_SMTP_PASS?: string;
  DEFAULT_SMTP_FROM_ADDRESS?: string;
  DEFAULT_SMTP_FROM_NAME?: string;
}
