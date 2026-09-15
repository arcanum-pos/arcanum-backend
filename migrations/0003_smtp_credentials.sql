-- One-time migration for the existing production `questo-transactions` D1
-- database: adds per-org SMTP credentials (see organizations/smtp-credentials.ts).
-- Run once via:
--   wrangler d1 execute questo-transactions --remote --file=migrations/0003_smtp_credentials.sql
CREATE TABLE IF NOT EXISTS smtp_credentials (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  host TEXT,
  port INTEGER,
  username TEXT,
  password_ciphertext TEXT,
  password_iv TEXT,
  from_address TEXT,
  from_name TEXT,
  updated_at TEXT NOT NULL
);
