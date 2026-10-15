-- Fast board→report resolution. The board GET resolves each item's newest
-- saved report by leadId (stored inside full_response_json) or address.
-- Without these indexes both lookups scan every saved_reports row.
ALTER TABLE saved_reports
  ADD COLUMN lead_id_gen TEXT GENERATED ALWAYS AS (json_extract(full_response_json, '$.leadId')) VIRTUAL;
CREATE INDEX idx_saved_reports_lead_gen ON saved_reports(lead_id_gen);
CREATE INDEX idx_saved_reports_property_address ON saved_reports(property_address);
