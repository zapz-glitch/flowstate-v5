CREATE TABLE `waitlist` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `waitlist_email_unique` ON `waitlist` (`email`);--> statement-breakpoint
CREATE INDEX `idx_waitlist_email` ON `waitlist` (`email`);