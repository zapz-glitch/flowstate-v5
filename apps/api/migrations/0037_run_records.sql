-- Immutable evaluation evidence record. saved_reports remains the current
-- property view; every evaluation/rerun gets its own canonical payload here.
CREATE TABLE IF NOT EXISTS run_records (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  report_id TEXT REFERENCES saved_reports(id) ON DELETE SET NULL,
  property_address TEXT,
  property_city TEXT,
  property_state TEXT,
  property_zip TEXT,
  property_clip TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  arv REAL,
  result_grade TEXT,
  process_grade TEXT,
  harness_version TEXT,
  pipeline_version TEXT,
  request_hash TEXT,
  evidence_hash TEXT,
  payload_hash TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  comp_count INTEGER,
  enabled_comp_count INTEGER,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_records_job_id ON run_records(job_id);
CREATE INDEX IF NOT EXISTS idx_run_records_user_id ON run_records(user_id);
CREATE INDEX IF NOT EXISTS idx_run_records_report_id ON run_records(report_id);
CREATE INDEX IF NOT EXISTS idx_run_records_payload_hash ON run_records(payload_hash);
CREATE INDEX IF NOT EXISTS idx_run_records_property ON run_records(user_id, property_address);
CREATE INDEX IF NOT EXISTS idx_run_records_created_at ON run_records(created_at);
