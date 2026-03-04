CREATE TABLE `appraisal_rule_adjustment` (
	`id` text PRIMARY KEY NOT NULL,
	`preset_id` text NOT NULL,
	`adjustment_type` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`percentage` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`preset_id`) REFERENCES `appraisal_rule_preset`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_appraisal_rule_adjustment_preset_id` ON `appraisal_rule_adjustment` (`preset_id`);--> statement-breakpoint
CREATE TABLE `appraisal_rule_filter` (
	`id` text PRIMARY KEY NOT NULL,
	`preset_id` text NOT NULL,
	`filter_type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`value` real NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`preset_id`) REFERENCES `appraisal_rule_preset`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_appraisal_rule_filter_preset_id` ON `appraisal_rule_filter` (`preset_id`);--> statement-breakpoint
CREATE TABLE `appraisal_rule_preset` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_appraisal_rule_preset_user_id` ON `appraisal_rule_preset` (`user_id`);