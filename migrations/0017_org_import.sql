-- Org data import (self-hosting move, see org-transfer.ts): an org being
-- imported stays in import_status = 'importing' until /import/finish has
-- verified every table's row count against the manifest. import_key is the
-- per-import random key every id is remapped with (deterministic, so a
-- retried chunk inserts nothing twice); import_manifest holds the expected
-- counts. All three are cleared on finish.
-- Run once via:
--   wrangler d1 execute arcanum-backend --remote --file=migrations/0017_org_import.sql
ALTER TABLE organizations ADD COLUMN import_status TEXT;
ALTER TABLE organizations ADD COLUMN import_key TEXT;
ALTER TABLE organizations ADD COLUMN import_manifest TEXT;
