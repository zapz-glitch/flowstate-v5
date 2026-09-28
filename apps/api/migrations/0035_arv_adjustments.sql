-- Per-user ARV adjustment rules — characteristic-based percent deductions/
-- additions applied to subject ARV during report review.
CREATE TABLE IF NOT EXISTS arv_adjustments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arv_adjustments_user_id ON arv_adjustments(user_id);
