CREATE TABLE `harness_queue` (
	`job_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`property_address` text,
	`property_city` text,
	`property_state` text,
	`property_zip` text,
	`status` text NOT NULL DEFAULT 'awaiting_agent',
	`claimed_by` text,
	`claimed_at` text,
	`lease_expires_at` text,
	`rounds` integer NOT NULL DEFAULT 0,
	`deadline_at` text,
	`parked_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_harness_queue_user_status` ON `harness_queue` (`user_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_harness_queue_lease` ON `harness_queue` (`lease_expires_at`);
