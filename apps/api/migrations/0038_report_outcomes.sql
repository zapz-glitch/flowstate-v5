-- Actual sale outcome after a saved prediction. Separate rows preserve the
-- prediction record; outcomes never mutate the report's original ARV.
CREATE TABLE IF NOT EXISTS report_outcomes (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  run_record_id TEXT REFERENCES run_records(id) ON DELETE SET NULL,
  job_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  actual_sale_price REAL NOT NULL,
  actual_sale_date TEXT,
  source TEXT,
  note TEXT,
  predicted_arv REAL,
  prediction_delta REAL,
  prediction_delta_pct REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_outcomes_report_id ON report_outcomes(report_id);
CREATE INDEX IF NOT EXISTS idx_report_outcomes_job_id ON report_outcomes(job_id);
CREATE INDEX IF NOT EXISTS idx_report_outcomes_run_record_id ON report_outcomes(run_record_id);
CREATE INDEX IF NOT EXISTS idx_report_outcomes_user_id ON report_outcomes(user_id, created_at);
