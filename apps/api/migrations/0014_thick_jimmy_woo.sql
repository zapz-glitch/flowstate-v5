CREATE TABLE `photo_analysis_results` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`findings_json` text NOT NULL,
	`model` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_photo_analysis_user_job` ON `photo_analysis_results` (`user_id`,`job_id`);--> statement-breakpoint
CREATE TABLE `report_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_report_photos_user_job` ON `report_photos` (`user_id`,`job_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_deal_params` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`closing_costs_percent` real DEFAULT 8 NOT NULL,
	`carrying_costs_percent` real DEFAULT 2 NOT NULL,
	`wholesale_fee` real DEFAULT 10000 NOT NULL,
	`desired_profit` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_deal_params`("id", "user_id", "closing_costs_percent", "carrying_costs_percent", "wholesale_fee", "desired_profit", "created_at", "updated_at") SELECT "id", "user_id", "closing_costs_percent", "carrying_costs_percent", "wholesale_fee", "desired_profit", "created_at", "updated_at" FROM `deal_params`;--> statement-breakpoint
DROP TABLE `deal_params`;--> statement-breakpoint
ALTER TABLE `__new_deal_params` RENAME TO `deal_params`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `deal_params_user_id_unique` ON `deal_params` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_deal_params_user_id` ON `deal_params` (`user_id`);