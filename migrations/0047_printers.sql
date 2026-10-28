-- Ticket printers (2026-10-28, arcanum/PRINTING.md): a printer is a device
-- of the org, managed in the console under Toestellen. Epson first; push
-- = a screen on the printer's network sends to host:port (ePOS-Print),
-- poll = the printer asks Arcanum (Server Direct Print, phase 3).
CREATE TABLE IF NOT EXISTS printers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  brand TEXT NOT NULL CHECK (brand IN ('epson', 'star')),
  connection TEXT NOT NULL CHECK (connection IN ('push', 'poll')),
  host TEXT,
  port INTEGER,
  -- ePOS-Print's device id: local_printer is the printer itself.
  device_id TEXT NOT NULL DEFAULT 'local_printer',
  paper_mm INTEGER NOT NULL DEFAULT 80 CHECK (paper_mm IN (58, 80)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_printers_org ON printers(org_id);

-- Which printer prints a prep station's tickets (none: not printed).
ALTER TABLE prep_stations ADD COLUMN printer_id TEXT REFERENCES printers(id);

-- One thing to print on one printer, printed exactly once: waiting ->
-- claimed (one conditional UPDATE: of several screens, or the printer
-- itself, exactly one wins) -> printed or failed. A claim not reported
-- within 30 s is claimable again. `document` is the ePOS-Print XML.
CREATE TABLE IF NOT EXISTS print_jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  printer_id TEXT NOT NULL REFERENCES printers(id),
  kind TEXT NOT NULL CHECK (kind IN ('ticket', 'receipt', 'test')),
  -- What it prints: a prep ticket's id (a ticket is queued once), a tab's.
  ref_id TEXT,
  title TEXT NOT NULL,
  document TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'claimed', 'printed', 'failed')),
  claim_token TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_print_jobs_ticket ON print_jobs(ref_id) WHERE kind = 'ticket';
CREATE INDEX IF NOT EXISTS idx_print_jobs_printer ON print_jobs(printer_id, status, created_at);
