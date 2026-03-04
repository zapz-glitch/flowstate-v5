CREATE TABLE `process_doc_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`section_id` text NOT NULL,
	`parent_id` text,
	`content` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_pdc_section` ON `process_doc_comments` (`section_id`);--> statement-breakpoint
CREATE INDEX `idx_pdc_user` ON `process_doc_comments` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_pdc_parent` ON `process_doc_comments` (`parent_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_usage_logs` (
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
INSERT INTO `__new_api_usage_logs`("id", "api_key_id", "user_id", "endpoint", "method", "status_code", "response_time_ms", "property_address", "property_city", "property_state", "ip_address", "user_agent", "error_message", "request_body", "response_body", "request_headers", "created_at") SELECT "id", "api_key_id", "user_id", "endpoint", "method", "status_code", "response_time_ms", "property_address", "property_city", "property_state", "ip_address", "user_agent", "error_message", "request_body", "response_body", "request_headers", "created_at" FROM `api_usage_logs`;--> statement-breakpoint
DROP TABLE `api_usage_logs`;--> statement-breakpoint
ALTER TABLE `__new_api_usage_logs` RENAME TO `api_usage_logs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_api_usage_logs_api_key_id` ON `api_usage_logs` (`api_key_id`);--> statement-breakpoint
CREATE INDEX `idx_api_usage_logs_user_id` ON `api_usage_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_api_usage_logs_created_at` ON `api_usage_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_api_usage_logs_endpoint` ON `api_usage_logs` (`endpoint`);