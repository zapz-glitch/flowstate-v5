-- Set-B mechanics columns on saved_reports — queryable QA fields extracted
-- from valuation.bMechanics so "all T3 fallbacks", "all healed runs" etc.
-- are index lookups instead of full_response_json parses.
ALTER TABLE saved_reports ADD COLUMN arv_source TEXT;
ALTER TABLE saved_reports ADD COLUMN b_confidence TEXT;
ALTER TABLE saved_reports ADD COLUMN b_healed INTEGER;
ALTER TABLE saved_reports ADD COLUMN b_anchor_address TEXT;
ALTER TABLE saved_reports ADD COLUMN b_flag_count INTEGER;
CREATE INDEX IF NOT EXISTS idx_saved_reports_arv_source ON saved_reports(user_id, arv_source);
