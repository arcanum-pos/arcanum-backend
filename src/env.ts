export interface Env {
  AUTH_SCHEME?: string;
  CHARGE_POLLER: DurableObjectNamespace;
  DB: D1Database;
  // Test-only: max D1 queries per invocation, enforced by query-budget.ts
  // (the suite sets 50, the Workers Free plan's limit). Unset in production.
  D1_QUERY_LIMIT?: string;
  // arcanum-devicehub (separate Worker) — see devicehub-client.ts.
  INTERNAL_API_KEY: string;
  // No longer read here: arcanum-bff signs people in with its own
  // DEFAULT_IDP_* (it used to ask this Worker's /identity-provider/resolve,
  // now gone). Still set by the installer (shared with the bff's).
  BFF_INTERNAL_KEY?: string;
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
  // The issuer of the installation's login provider: what every member's
  // (issuer, sub) belongs to (invites, demo orgs). Only the issuer: the bff
  // signs people in with its own client id and secret (MAIL.md decision 6).
  DEFAULT_IDP_ISSUER_URL?: string;
  // The installation's mail account (MAIL.md), set by its installer
  // (Geavanceerd → E-mail): {"provider":"smtp"|"gmail_api"|"brevo"|"resend"|…,
  // …that service's settings} — or {"provider", "credentials": {…}}. When
  // set, every organisation's mail goes through it; without it, invites
  // aren't mailed (the console offers the invitation to copy).
  MAIL_CONFIG?: string;
}
