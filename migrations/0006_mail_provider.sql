-- One-time migration for the existing production `questo-transactions` D1
-- database: lets an org choose the Gmail API (a domain-wide-delegated
-- service account) as its outbound mail transport instead of SMTP — see
-- organizations/mail-provider.ts and organizations/gmail-api-credentials.ts.
-- `mail_provider` defaults every org to 'smtp' with no row needed, so
-- existing orgs keep working unchanged.
--   wrangler d1 execute questo-transactions --remote --file=migrations/0006_mail_provider.sql

CREATE TABLE IF NOT EXISTS mail_provider (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  provider TEXT NOT NULL DEFAULT 'smtp' CHECK (provider IN ('smtp', 'gmail_api')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gmail_api_credentials (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  client_email TEXT,
  private_key_ciphertext TEXT,
  private_key_iv TEXT,
  impersonated_user TEXT,
  from_name TEXT,
  updated_at TEXT NOT NULL
);
