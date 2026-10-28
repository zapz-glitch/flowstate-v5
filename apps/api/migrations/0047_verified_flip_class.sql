-- Flip class (owner 2026-10-28): 'arv' when the resale $/sf is at or above
-- the true neighborhood median, 'budget' below it, 'wholesale' for a quick
-- thin turn. Only 'arv' flips are ARV truth for backtests.
ALTER TABLE `verified_flips` ADD `flip_class` text;
ALTER TABLE `verified_flips` ADD `resale_vs_median` real;
