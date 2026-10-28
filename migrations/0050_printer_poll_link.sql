-- A polling printer's URL can be shown again in the console (only to an
-- admin): its secret also kept encrypted under the org's data key, next to
-- the SHA-256 the printer's requests are checked against. NULL for a
-- printer made before: "Nieuwe link" makes one that can be shown.
ALTER TABLE printers ADD COLUMN poll_key_ciphertext TEXT;
ALTER TABLE printers ADD COLUMN poll_key_iv TEXT;
