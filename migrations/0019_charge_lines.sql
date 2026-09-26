-- Split payments "per item" (DOMAIN_MODEL.md "Split payments"): which units
-- of which order line a payment covers. Written with the charge; the units
-- count as paid only once that charge succeeded (so a failed payment frees
-- them again). Paid units can't be paid again or voided.
-- Applied with: wrangler d1 migrations apply arcanum-backend --remote
CREATE TABLE IF NOT EXISTS charge_lines (
  charge_id TEXT NOT NULL REFERENCES charges(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  tab_id TEXT NOT NULL REFERENCES tabs(id),
  line_id TEXT NOT NULL REFERENCES order_lines(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (charge_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_charge_lines_tab ON charge_lines(tab_id);
CREATE INDEX IF NOT EXISTS idx_charge_lines_line ON charge_lines(line_id);
