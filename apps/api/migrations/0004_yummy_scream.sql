CREATE TABLE `deal_params` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`closing_costs_percent` real DEFAULT 10 NOT NULL,
	`carrying_costs_percent` real DEFAULT 5 NOT NULL,
	`wholesale_fee` real DEFAULT 10000 NOT NULL,
	`desired_profit` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deal_params_user_id_unique` ON `deal_params` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_deal_params_user_id` ON `deal_params` (`user_id`);