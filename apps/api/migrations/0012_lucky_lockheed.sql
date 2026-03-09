ALTER TABLE `saved_reports` ADD `is_shared` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `saved_reports` ADD `share_password_hash` text;