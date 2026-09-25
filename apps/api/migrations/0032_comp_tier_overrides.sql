-- Manual comp tier assignments — a reviewer can pin a comparable to the
-- ARV or as-is tier on the comp card (Property Search) or report. Keyed by
-- (job_id, comp_id) so the override survives cache hits and saved reports,
-- and Jev's automatic classification stays visible alongside it.
CREATE TABLE comp_tier_overrides (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  comp_id TEXT NOT NULL,
  tier TEXT NOT NULL,            -- 'arv' | 'as_is'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(job_id, comp_id)
);
CREATE INDEX idx_comp_tier_overrides_job ON comp_tier_overrides(job_id);
