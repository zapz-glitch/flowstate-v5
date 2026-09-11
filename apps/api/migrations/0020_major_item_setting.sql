CREATE TABLE `major_item_setting` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cost` integer NOT NULL,
	`age_threshold` integer,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_major_item_setting_user_id` ON `major_item_setting` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_major_item_setting_user_item` ON `major_item_setting` (`user_id`,`item_id`);
