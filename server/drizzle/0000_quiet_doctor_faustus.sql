CREATE TABLE `auth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE INDEX `auth_codes_email_idx` ON `auth_codes` (`email`);--> statement-breakpoint
CREATE TABLE `contribution_credits` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`report_id` text NOT NULL,
	`earned_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_id`) REFERENCES `price_reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contribution_credits_user_idx` ON `contribution_credits` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `contribution_credits_report_unique` ON `contribution_credits` (`report_id`);--> statement-breakpoint
CREATE TABLE `current_prices` (
	`product_id` text NOT NULL,
	`store_id` text NOT NULL,
	`report_id` text NOT NULL,
	`price_cents` integer NOT NULL,
	`observed_date` text NOT NULL,
	`expires_at` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`is_stale` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`product_id`, `store_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_id`) REFERENCES `price_reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `free_tier_products` (
	`region_key` text NOT NULL,
	`product_id` text NOT NULL,
	`rank` integer NOT NULL,
	`entered_at` text NOT NULL,
	`computed_at` text NOT NULL,
	PRIMARY KEY(`region_key`, `product_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `price_reports` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text,
	`store_id` text,
	`item_name` text NOT NULL,
	`brand` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`quantity` real,
	`quantity_units` text,
	`price_cents` integer NOT NULL,
	`price_raw` text NOT NULL,
	`observed_date` text NOT NULL,
	`expires_at` text,
	`is_sale` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'scan' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`review_reason` text,
	`confirm_count` integer DEFAULT 0 NOT NULL,
	`flag_weight` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_reports_id_unique` ON `price_reports` (`id`);--> statement-breakpoint
CREATE INDEX `price_reports_user_idx` ON `price_reports` (`user_id`);--> statement-breakpoint
CREATE INDEX `price_reports_product_store_idx` ON `price_reports` (`product_id`,`store_id`);--> statement-breakpoint
CREATE TABLE `product_tokens` (
	`product_id` text NOT NULL,
	`token` text NOT NULL,
	PRIMARY KEY(`product_id`, `token`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `product_tokens_token_idx` ON `product_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_name` text NOT NULL,
	`brand_key` text DEFAULT '' NOT NULL,
	`size_family` text DEFAULT 'unknown' NOT NULL,
	`size_base_qty` real,
	`size_label` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`report_count` integer DEFAULT 0 NOT NULL,
	`median_price_cents` integer,
	`merged_into` text,
	`possible_duplicate_of` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`merged_into`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`possible_duplicate_of`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `products_brand_key_idx` ON `products` (`brand_key`);--> statement-breakpoint
CREATE INDEX `products_size_family_idx` ON `products` (`size_family`);--> statement-breakpoint
CREATE TABLE `report_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`resolution` text,
	`resolved_at` text,
	FOREIGN KEY (`report_id`) REFERENCES `price_reports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_votes_report_user_unique` ON `report_votes` (`report_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `stores` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`lat` real,
	`lon` real,
	`geohash7` text,
	`chain_key` text NOT NULL,
	`is_chain_level` integer DEFAULT false NOT NULL,
	`store_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stores_store_key_unique` ON `stores` (`store_key`);--> statement-breakpoint
CREATE INDEX `stores_chain_key_idx` ON `stores` (`chain_key`);--> statement-breakpoint
CREATE INDEX `stores_lat_lon_idx` ON `stores` (`lat`,`lon`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text DEFAULT 'stripe' NOT NULL,
	`provider_ref` text NOT NULL,
	`status` text NOT NULL,
	`current_period_end` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `subscriptions_user_idx` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`display_name` text,
	`trust_score` real DEFAULT 0.5 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`reports_count` integer DEFAULT 0 NOT NULL,
	`confirmed_count` integer DEFAULT 0 NOT NULL,
	`upheld_flags_count` integer DEFAULT 0 NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`plan_expires_at` text,
	`home_lat` real,
	`home_lon` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);