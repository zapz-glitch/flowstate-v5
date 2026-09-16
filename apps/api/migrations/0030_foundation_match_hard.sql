-- Promote foundation_match to a hard appraisal rule on existing presets.
-- New presets seed priority='hard' from DEFAULT_FILTERS; presets created
-- before the promotion still carry 'soft' or NULL (system default was soft).
-- Promote both; users can re-demote via the Pref toggle in Evaluation Settings.
UPDATE appraisal_rule_filter
SET priority = 'hard'
WHERE filter_type = 'foundation_match'
  AND (priority IS NULL OR priority = 'soft');
