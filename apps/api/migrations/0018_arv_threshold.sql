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
--> statement-breakpoint
ALTER TABLE `deal_params` ADD `as_is_threshold_percent` real DEFAULT 70 NOT NULL;
--> statement-breakpoint
CREATE TABLE `proximity_config` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`config_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proximity_config_user_id_unique` ON `proximity_config` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_proximity_config_user_id` ON `proximity_config` (`user_id`);
--> statement-breakpoint
ALTER TABLE `location_settings` ADD `proximity_config_json` text;
