-- Pocket presence: score pockets once, reuse across evals (90-day refresh).
-- Spec: docs/POCKET-PRESENCE-SPEC.md

CREATE TABLE IF NOT EXISTS pocket_scores (
  pocket_key     TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  metro          TEXT,
  city           TEXT,
  state          TEXT,
  zip            TEXT,
  census_tract   TEXT,
  block_group    TEXT,
  score          REAL,
  median_lo      REAL,
  median_hi      REAL,
  inputs_json    TEXT,
  evidence_json  TEXT,
  scored_by      TEXT,
  eval_count     INTEGER NOT NULL DEFAULT 0,
  scored_at      TEXT,
  refresh_due_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pocket_scores_metro ON pocket_scores(metro);
CREATE INDEX IF NOT EXISTS idx_pocket_scores_refresh ON pocket_scores(refresh_due_at);

-- City → metro umbrella, classified once and cached.
CREATE TABLE IF NOT EXISTS metro_map (
  city_key    TEXT PRIMARY KEY,   -- 'statham|ga'
  metro       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
