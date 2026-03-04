CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` text,
	`refreshTokenExpiresAt` text,
	`scope` text,
	`password` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`monthly_quota` integer,
	`current_usage` integer DEFAULT 0 NOT NULL,
	`quota_reset_at` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_api_keys_user_id` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_key_hash` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `api_usage_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`method` text NOT NULL,
	`status_code` integer NOT NULL,
	`response_time_ms` integer,
	`property_address` text,
	`property_city` text,
	`property_state` text,
	`ip_address` text,
	`user_agent` text,
	`error_message` text,
	`request_body` text,
	`response_body` text,
	`request_headers` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_api_usage_logs_api_key_id` ON `api_usage_logs` (`api_key_id`);--> statement-breakpoint
CREATE INDEX `idx_api_usage_logs_user_id` ON `api_usage_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_api_usage_logs_created_at` ON `api_usage_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_api_usage_logs_endpoint` ON `api_usage_logs` (`endpoint`);--> statement-breakpoint
CREATE TABLE `llm_usage_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`estimated_cost_usd` real,
	`latency_ms` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_llm_usage_logs_user_id` ON `llm_usage_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_logs_api_key_id` ON `llm_usage_logs` (`api_key_id`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_logs_request_id` ON `llm_usage_logs` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_logs_created_at` ON `llm_usage_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_logs_provider` ON `llm_usage_logs` (`provider`);--> statement-breakpoint
CREATE TABLE `saved_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`api_key_id` text,
	`property_address` text NOT NULL,
	`property_city` text NOT NULL,
	`property_state` text NOT NULL,
	`property_zip` text,
	`property_clip` text,
	`property_data` text,
	`comparables_data` text,
	`valuation_data` text,
	`arv` real,
	`as_is_value` real,
	`max_allowable_offer` real,
	`estimated_repairs` real,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_saved_reports_user_id` ON `saved_reports` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_saved_reports_created_at` ON `saved_reports` (`created_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` text NOT NULL,
	`token` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`stripe_price_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`current_period_start` text,
	`current_period_end` text,
	`cancel_at_period_end` integer DEFAULT false,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_user_id_unique` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_subscriptions_user_id` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_subscriptions_stripe_customer_id` ON `subscriptions` (`stripe_customer_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` text NOT NULL,
	`createdAt` text,
	`updatedAt` text
);
