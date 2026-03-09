CREATE TABLE `ghl_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`api_token` text NOT NULL,
	`location_id` text NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`webhook_secret` text NOT NULL,
	`field_mappings` text,
	`monetary_value_field` text DEFAULT 'arv',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ghl_settings_user_id_unique` ON `ghl_settings` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_ghl_settings_user_id` ON `ghl_settings` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_ghl_settings_webhook_secret` ON `ghl_settings` (`webhook_secret`);