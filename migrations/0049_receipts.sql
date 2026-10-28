-- Receipts on a printer (arcanum/PRINTING.md): switched on per
-- organisation - most have no printer. Off by default.
ALTER TABLE organizations ADD COLUMN receipts_enabled INTEGER NOT NULL DEFAULT 0;
