CREATE TABLE IF NOT EXISTS `run_telemetry` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`user_id` text,
	`address` text,
	`arv` integer,
	`arv_source` text,
	`confidence` text,
	`bracket` text,
	`anchor_address` text,
	`pool_size` integer,
	`enabled_count` integer,
	`driver_count` integer,
	`decisions_json` text,
	`bands_json` text,
	`rules_fired_json` text,
	`duration_ms` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_run_telemetry_addr` ON `run_telemetry` (`address`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_run_telemetry_created` ON `run_telemetry` (`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_run_telemetry_job` ON `run_telemetry` (`job_id`);
