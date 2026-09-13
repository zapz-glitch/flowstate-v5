-- Add required/preferred (hard/soft) priority to appraisal rule filters.
-- NULL means "use the system default for this filter type" so existing rows
-- keep their current semantics (hard rules stay hard, match filters stay soft).
ALTER TABLE appraisal_rule_filter ADD COLUMN priority TEXT;
