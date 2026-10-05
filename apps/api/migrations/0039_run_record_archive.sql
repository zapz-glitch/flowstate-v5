-- R2 archive tracking for run_records. The D1 row is the query surface; the
-- R2 object is the recoverable canonical payload. Failures stay retryable.
ALTER TABLE run_records ADD COLUMN archive_key TEXT;
ALTER TABLE run_records ADD COLUMN archived_at TEXT;
ALTER TABLE run_records ADD COLUMN archive_error TEXT;
