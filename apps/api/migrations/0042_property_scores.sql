-- Per-property dual scores — pocket + economics + overall + evidence flag.
-- Written post-eval by the scoring job; queue reads join on job_id.
CREATE TABLE IF NOT EXISTS property_scores (
  job_id TEXT PRIMARY KEY,
  user_id TEXT,
  address TEXT,
  pocket_key TEXT,
  pocket_score REAL,
  pocket_rationale TEXT,
  economics_score REAL,
  economics_rationale TEXT,
  overall_score REAL,
  evidence_quality TEXT,          -- strong | thin
  contract_fallouts INTEGER DEFAULT 0,
  days_on_market INTEGER,
  list_price REAL,
  wholesale_price REAL,
  inputs_json TEXT,
  scored_at TEXT NOT NULL,
  FOREIGN KEY (pocket_key) REFERENCES pocket_scores(pocket_key)
);
CREATE INDEX IF NOT EXISTS idx_property_scores_user ON property_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_property_scores_overall ON property_scores(overall_score DESC);
