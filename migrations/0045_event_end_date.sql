-- An event can run over several days (2026-10-23): its last day, included.
-- NULL: a one-day event (its end is its event_date).
ALTER TABLE events ADD COLUMN end_date TEXT;
