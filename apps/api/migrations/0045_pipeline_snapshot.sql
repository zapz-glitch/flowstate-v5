CREATE TABLE `pipeline_snapshot` (
	`path` text PRIMARY KEY NOT NULL,
	`body_json` text NOT NULL,
	`refreshed_at` text NOT NULL
);
