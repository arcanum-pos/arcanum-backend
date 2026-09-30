export interface Env {
  AUTH_SCHEME?: string;
  CHARGE_POLLER: DurableObjectNamespace;
  DB: D1Database;
  // Test-only: max D1 queries per invocation, enforced by query-budget.ts
  // (the suite sets 50, the Workers Free plan's limit). Unset in production.
  D1_QUERY_LIMIT?: string;
  // arcanum-devicehub (separate Worker) — see devicehub-client.ts.
  INTERNAL_API_KEY: string;
  // arcanum-bff's calls to this Worker's own internal-only
  // /identity-provider/resolve route — see
  // organizations/identity-providers.ts. Deliberately a separate secret
  // from INTERNAL_API_KEY above (a different pairwise relationship,
  // independently rotatable) — not the same value.
  BFF_INTERNAL_KEY: string;
  ARCANUM_DEVICEHUB_SERVICE: Fetcher;
  DEVICEHUB_LOCAL_URL?: string;
  // arcanum-mailer (separate Worker) — see mailer-client.ts. A different
  // secret from INTERNAL_API_KEY/BFF_INTERNAL_KEY above, same "one secret
  // per pairwise relationship" reasoning.
  ARCANUM_MAILER_SERVICE: Fetcher;
  MAILER_LOCAL_URL?: string;
  MAILER_INTERNAL_KEY: string;
  // Platform-wide key-encryption-key — wraps each organization's own data
  // key (envelope encryption). See organizations/crypto.ts.
  ENCRYPTION_KEY: string;
  // This Worker's own publicly reachable base URL, reached through the BFF
  // — used to build the callbackUrl/return_url handed to Bancontact/SumUp
  // at charge creation (see payments/bancontact.ts, payments/sumup.ts).
  PUBLIC_BASE_URL: string;
  // Self-hosted installations: who may create/import orgs (see
  // organizations/instance-admins.ts). Unset = anyone who can log in.
  INSTANCE_ADMIN_EMAILS?: string;
  // What kind of installation this is, for creating orgs: 'admins' (unset:
  // the allowlist above), 'single' (own instance: its first org only) or
  // 'internal' (demo instance: only POST /internal/demo-orgs). See
  // organizations/org-creation.ts.
  ORG_CREATION?: string;
  // Demo orgs (demo-orgs.ts, only with ORG_CREATION=internal). The lifetime
  // shown to the user (organization JSON `demo.expiresAt`) — keep it equal
  // to arcanum-cleaner's MIN_AGE_HOURS, which does the actual deleting.
  // Default 4.
  DEMO_LIFETIME_HOURS?: string;
  // Most live demo orgs at once (default 20) — Free-plan quotas are per account.
  DEMO_MAX_LIVE?: string;
  // Where a demo's "Eigen installatie" link points (the bootstrapper); unset = no link.
  DEMO_INSTALL_URL?: string;
  // The bootstrapper's bearer key for POST /internal/demo-orgs. Unset = the
  // endpoint refuses everything.
  BOOTSTRAP_API_KEY?: string;
  // Seeds the instance's identity provider (the `default` identity_providers
  // row — every org on this installation logs in through it) — see
  // organizations/identity-providers.ts `ensureDefaultOrganization`. Consumed only once, at first seed; safe to
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
  // Optional overrides for the seeded default provider — Google needs both:
  // scopes without `offline_access`, and a separate client for browser
  // login (the primary client above then does the device login).
  DEFAULT_IDP_SCOPES?: string;
  DEFAULT_IDP_AUTH_CODE_CLIENT_ID?: string;
  DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET?: string;
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
