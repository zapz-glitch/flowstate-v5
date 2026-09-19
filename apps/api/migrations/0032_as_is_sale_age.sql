-- Editable max sale age (days) for as-is/investment comp evidence.
-- Relaxes only the appraisal sale_age filter for the as-is bucket; ARV
-- eligibility still uses the configured sale_age filter value.
-- Default 548 (~18 months); editable via Evaluation Settings.
ALTER TABLE deal_params ADD COLUMN as_is_sale_age_days REAL NOT NULL DEFAULT 548;
