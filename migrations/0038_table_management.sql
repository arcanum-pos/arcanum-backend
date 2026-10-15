-- Table management (DOMAIN_MODEL.md "Tables and waiters", release D).
-- needs_clearing_at: guests moved away or joined another table — it's Af te
-- ruimen until "Opgeruimd", like after paying. promised_at: promised to
-- guests waiting at the entrance (D5: seating them clears it).
ALTER TABLE tables ADD COLUMN needs_clearing_at TEXT;
ALTER TABLE tables ADD COLUMN promised_at TEXT;
