-- Conversation-intelligence engine activity events (Analytics dashboard).
-- The CI worker POSTs {kind, value, leadId, propertyAddress, ts, meta} to
-- POST /v1/activity (Bearer CI_INGEST_KEY); rows power metric drill-downs
-- and per-kind summary counts on /dashboard/analytics.
CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- reachout, response, stage_move, offer_sent, …
  value TEXT,                       -- Close activity id, stage name, checkin type…
  lead_id TEXT,                     -- Close lead id when lead-scoped
  property_address TEXT,
  ts TEXT NOT NULL,                 -- event time ISO
  meta TEXT,                        -- JSON payload (stage, contact_hour, …)
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_activity_events_kind_ts ON activity_events(kind, ts);
CREATE INDEX idx_activity_events_ts ON activity_events(ts);
CREATE INDEX idx_activity_events_lead_id ON activity_events(lead_id);
