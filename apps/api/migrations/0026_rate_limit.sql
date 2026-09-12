CREATE TABLE `rateLimit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`lastRequest` integer NOT NULL
);
CREATE UNIQUE INDEX `rateLimit_key_unique` ON `rateLimit` (`key`);
