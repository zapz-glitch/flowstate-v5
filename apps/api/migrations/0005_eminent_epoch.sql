CREATE TABLE `location_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`state` text,
	`city` text,
	`zip_code` text,
	`appraisal_preset_id` text,
	`rehab_config_json` text,
	`deal_params_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`appraisal_preset_id`) REFERENCES `appraisal_rule_preset`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_location_settings_user_id` ON `location_settings` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_location_settings_zip` ON `location_settings` (`user_id`,`zip_code`);--> statement-breakpoint
CREATE INDEX `idx_location_settings_city` ON `location_settings` (`user_id`,`city`);--> statement-breakpoint
CREATE INDEX `idx_location_settings_state` ON `location_settings` (`user_id`,`state`);