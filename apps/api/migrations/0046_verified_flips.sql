-- Verified flips — buy → renovate → resell pairs from provider sales-history,
-- recorded from every evaluation's comps. Known resale prices for A/B and
-- accuracy tests (services/verified-flips, scripts/flip-backtest.mjs).
CREATE TABLE `verified_flips` (
	`id` text PRIMARY KEY NOT NULL,
	`address_key` text NOT NULL,
	`address` text NOT NULL,
	`state` text,
	`provider_id` text,
	`latitude` real,
	`longitude` real,
	`square_feet` integer,
	`year_built` integer,
	`bedrooms` real,
	`bathrooms` real,
	`buy_price` real NOT NULL,
	`buy_date` text NOT NULL,
	`sell_price` real NOT NULL,
	`sell_date` text NOT NULL,
	`days_held` integer NOT NULL,
	`gain_pct` real NOT NULL,
	`confidence` text NOT NULL,
	`reasons_json` text,
	`source` text DEFAULT 'attom-sales-history' NOT NULL,
	`first_job_id` text,
	`last_job_id` text,
	`seen_count` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE UNIQUE INDEX `uq_verified_flips_sale` ON `verified_flips` (`address_key`,`sell_date`);
CREATE INDEX `idx_verified_flips_state_sold` ON `verified_flips` (`state`,`sell_date`);
CREATE INDEX `idx_verified_flips_confidence` ON `verified_flips` (`confidence`,`sell_date`);
