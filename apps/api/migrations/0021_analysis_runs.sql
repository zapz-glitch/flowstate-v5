CREATE TABLE `analysis_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`user_id` text NOT NULL,
	`property_address` text,
	`property_city` text,
	`property_state` text,
	`property_zip` text,
	`status` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`duration_ms` integer,
	`arv` real,
	`recommendation` text,
	`comp_count` integer,
	`enabled_comp_count` integer,
	`photo_provider` text,
	`photo_count` integer,
	`renovation_level_source` text,
	`vision_status` text,
	`steps_json` text,
	`fallbacks_json` text,
	`eval_json` text,
	`api_call_stats_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_analysis_runs_job_id` ON `analysis_runs` (`job_id`);--> statement-breakpoint
CREATE INDEX `idx_analysis_runs_user_id` ON `analysis_runs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_analysis_runs_status` ON `analysis_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_analysis_runs_created_at` ON `analysis_runs` (`created_at`);
