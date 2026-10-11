-- "Your order is ready" by SMS (MESSAGING.md): a guest leaves a phone
-- number on their order page; when a station's part of the order turns
-- ready, one SMS — through the installation's Twilio account
-- (MESSAGING_CONFIG, set in the installer). Per ordering mode on/off.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
ALTER TABLE event_order_modes ADD COLUMN notify_sms INTEGER NOT NULL DEFAULT 0;

-- The guest's number (E.164), kept only until it's no longer needed: every
-- station's SMS sent and the tab no longer open, or the tab cancelled, or a
-- day old at most.
ALTER TABLE tabs ADD COLUMN notify_phone TEXT;

-- Per prep ticket: its SMS — 'sending' (claimed, so never twice), 'sent',
-- 'failed', or 'capped' (the installation's daily maximum reached).
ALTER TABLE prep_tickets ADD COLUMN sms_status TEXT;

-- Every SMS attempt, for the daily maximum (rolling 24 hours, the whole
-- installation) and to see what went wrong. No phone numbers here.
CREATE TABLE IF NOT EXISTS sms_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ticket_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  provider_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_log_created ON sms_log(created_at);
