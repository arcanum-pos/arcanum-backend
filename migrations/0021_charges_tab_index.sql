-- A tab's charges by tab: every tab summary sums what's paid and lists the
-- methods it was paid with (tabs.ts SUMMARY_SELECT) — up to 200 tabs per
-- list for the kassa's Rekeningen overview. Only the partial "one pending
-- per tab" index covered tab_id so far.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
CREATE INDEX IF NOT EXISTS idx_charges_tab_status ON charges(tab_id, status);
