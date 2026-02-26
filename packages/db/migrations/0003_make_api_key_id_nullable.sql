-- Make api_key_id nullable in api_usage_logs to support dashboard requests
-- SQLite requires table recreation to change NOT NULL constraint

-- Create new table without NOT NULL on api_key_id
CREATE TABLE `api_usage_logs_new` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`method` text NOT NULL,
	`status_code` integer NOT NULL,
	`response_time_ms` integer,
	`property_address` text,
	`property_city` text,
	`property_state` text,
	`ip_address` text,
	`user_agent` text,
	`error_message` text,
	`request_body` text,
	`response_body` text,
	`request_headers` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Copy data from old table
INSERT INTO `api_usage_logs_new` SELECT * FROM `api_usage_logs`;
--> statement-breakpoint
-- Drop old table
DROP TABLE `api_usage_logs`;
--> statement-breakpoint
-- Rename new table to original name
ALTER TABLE `api_usage_logs_new` RENAME TO `api_usage_logs`;
--> statement-breakpoint
-- Recreate indexes
CREATE INDEX `idx_api_usage_logs_api_key_id` ON `api_usage_logs` (`api_key_id`);
--> statement-breakpoint
CREATE INDEX `idx_api_usage_logs_user_id` ON `api_usage_logs` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_api_usage_logs_created_at` ON `api_usage_logs` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_api_usage_logs_endpoint` ON `api_usage_logs` (`endpoint`);
