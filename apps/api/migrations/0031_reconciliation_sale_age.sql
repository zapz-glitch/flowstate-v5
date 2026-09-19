-- Editable max age (days) for a Zillow sale event to reconcile a comp's
-- stale provider sale price/date. Default 365; users can raise it toward
-- ~18 months via Evaluation Settings.
ALTER TABLE deal_params ADD COLUMN reconciliation_sale_age_days REAL NOT NULL DEFAULT 365;
