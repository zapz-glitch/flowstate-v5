CREATE TABLE `arv_threshold` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`percent` real DEFAULT 10 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arv_threshold_user_id_unique` ON `arv_threshold` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_arv_threshold_user_id` ON `arv_threshold` (`user_id`);
--> statement-breakpoint
ALTER TABLE `location_settings` ADD `arv_threshold_json` text;
