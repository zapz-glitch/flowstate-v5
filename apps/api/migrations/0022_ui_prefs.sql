CREATE TABLE `ui_prefs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`nav_labels_json` text,
	`custom_links_json` text,
	`favicon_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ui_prefs_user_id_unique` ON `ui_prefs` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_ui_prefs_user_id` ON `ui_prefs` (`user_id`);
