CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`project` text,
	`due_date` text,
	`done` integer DEFAULT 0 NOT NULL,
	`done_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_user_id` ON `tasks` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_done` ON `tasks` (`user_id`,`done`);
