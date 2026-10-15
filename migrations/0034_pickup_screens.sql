-- Pickup screens (ROADMAP.md §5): a station screen for guests, showing
-- only order numbers by status — read-only. A station screen's `view`:
-- NULL = the prep screen, 'pickup' = the pickup screen. Chosen when its
-- pairing code is made, kept with its station.
ALTER TABLE device_pairings ADD COLUMN view TEXT;
ALTER TABLE station_devices ADD COLUMN view TEXT;
