-- Web Push for self-ordering (ROADMAP §8b, release G'): the guest's browser
-- push subscription (endpoint and keys, JSON), kept only until the order is
-- ready (like notify_phone); per ticket, whether its notification went.
ALTER TABLE tabs ADD COLUMN push_subscription TEXT;
ALTER TABLE prep_tickets ADD COLUMN push_status TEXT;
