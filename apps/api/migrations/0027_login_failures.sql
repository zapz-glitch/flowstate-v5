CREATE TABLE `login_failures` (
	`ip` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`last_attempt` integer NOT NULL
);
