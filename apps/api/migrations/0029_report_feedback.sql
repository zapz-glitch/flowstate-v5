-- Report feedback stamps — batch review workflow (validate / flag-for-improvement).
-- feedback_status: 'validated' | 'improve'; notes + generated ticket text are kept
-- so the review decision is auditable later.
ALTER TABLE saved_reports ADD COLUMN feedback_status TEXT;
ALTER TABLE saved_reports ADD COLUMN feedback_notes TEXT;
ALTER TABLE saved_reports ADD COLUMN feedback_report TEXT;
ALTER TABLE saved_reports ADD COLUMN feedback_at TEXT;
