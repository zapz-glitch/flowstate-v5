ALTER TABLE `saved_reports` ADD `full_response_json` text;--> statement-breakpoint
ALTER TABLE `saved_reports` ADD `job_id` text;--> statement-breakpoint
ALTER TABLE `saved_reports` ADD `pdf_key` text;--> statement-breakpoint
CREATE INDEX `idx_saved_reports_job_id` ON `saved_reports` (`job_id`);