CREATE TABLE `batch_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`total_addresses` integer NOT NULL,
	`completed_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`addresses_json` text NOT NULL,
	`results_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_batch_jobs_user_id` ON `batch_jobs` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_batch_jobs_created_at` ON `batch_jobs` (`created_at`);
