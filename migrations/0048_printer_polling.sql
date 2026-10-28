-- A printer that asks for its work (arcanum/PRINTING.md, phase 3: Epson
-- Server Direct Print): the secret in its URL (only its SHA-256), how often
-- it asks (set in the printer too; shown in the console with its cost), and
-- when it last asked (written at most once a minute).
ALTER TABLE printers ADD COLUMN poll_key_hash TEXT;
ALTER TABLE printers ADD COLUMN poll_interval INTEGER NOT NULL DEFAULT 10;
ALTER TABLE printers ADD COLUMN last_poll_at TEXT;
