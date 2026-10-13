CREATE TABLE `offer_board` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`opportunity_id` text,
	`lead_id` text,
	`address` text NOT NULL,
	`display_name` text,
	`status` text DEFAULT 'terms_prep' NOT NULL,
	`offer_amount` real,
	`counter_amount` real,
	`terms_json` text,
	`note` text,
	`dismissed` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_offer_board_user` ON `offer_board` (`user_id`,`dismissed`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_offer_board_opp` ON `offer_board` (`opportunity_id`);
--> statement-breakpoint
CREATE INDEX `idx_offer_board_lead` ON `offer_board` (`lead_id`);
