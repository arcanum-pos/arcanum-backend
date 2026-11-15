-- Offline (OFFLINE.md): when the cloud warned an org's admins that its box
-- has sent nothing for an hour (src/sync/watch.ts); cleared by the next batch.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE sync_links ADD COLUMN warned_at TEXT;
