CREATE TABLE `rehab_config` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`config_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rehab_config_user_id_unique` ON `rehab_config` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_rehab_config_user_id` ON `rehab_config` (`user_id`);