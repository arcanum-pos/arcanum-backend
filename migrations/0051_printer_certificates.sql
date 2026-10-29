-- Trusting a push printer (arcanum/PRINTING.md, "Trusting a push printer"):
-- the printer's own self-signed certificate, uploaded by the command a
-- station screen shows (it also trusts it on that computer), so an iPad
-- can download it as a profile. Only the public certificate - nothing secret.
ALTER TABLE printers ADD COLUMN cert_pem TEXT;
ALTER TABLE printers ADD COLUMN cert_fingerprint TEXT;
ALTER TABLE printers ADD COLUMN cert_uploaded_at TEXT;

-- Short-lived codes for that: 'upload' (once, 15 minutes, in the command)
-- and 'profile' (10 minutes, any number of times: Safari may ask twice).
-- Only their SHA-256 is kept.
CREATE TABLE IF NOT EXISTS printer_cert_tokens (
  token_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  printer_id TEXT NOT NULL REFERENCES printers(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('upload', 'profile')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_printer_cert_tokens_printer ON printer_cert_tokens(printer_id, expires_at);
