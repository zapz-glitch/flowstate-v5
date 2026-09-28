-- Durable offer dispositions — the dispatch/decline outcome for a lead.
-- Upserted on every attempt; latest wins (re-dispatching an offer updates
-- the row, so the dashboard always shows the current disposition + date).
CREATE TABLE IF NOT EXISTS offer_dispositions (
  disposition_key TEXT PRIMARY KEY,  -- lead_<id> or addr:<normalized>
  lead_id TEXT,
  property_address TEXT,
  job_id TEXT,
  workflow TEXT NOT NULL,            -- 'prep_offer' | 'no_margin'
  ok INTEGER NOT NULL DEFAULT 1,     -- 0 = dispatch attempt failed
  purchase_price REAL,
  opportunity_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_offer_dispositions_updated
  ON offer_dispositions (updated_at DESC);
