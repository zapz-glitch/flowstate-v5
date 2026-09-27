-- Pipeline state for the offer funnel — events append-only, items = live queue.

CREATE TABLE `pipeline_items` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`stage` text NOT NULL,
	`stage_entered_at` text NOT NULL,
	`lead_id` text,
	`opportunity_id` text,
	`job_id` text,
	`wholesale_price` real,
	`decided_at` text,
	`decision` text,
	`decision_seconds` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE INDEX `idx_pipeline_items_stage` ON `pipeline_items` (`stage`,`stage_entered_at`);

CREATE TABLE `pipeline_events` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text,
	`lead_id` text,
	`type` text NOT NULL,
	`payload_json` text,
	`at` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE INDEX `idx_pipeline_events_type` ON `pipeline_events` (`type`,`at`);
CREATE INDEX `idx_pipeline_events_item` ON `pipeline_events` (`item_id`);
