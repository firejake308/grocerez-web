CREATE TABLE `rate_limit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bucket` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limit_events_bucket_idx` ON `rate_limit_events` (`bucket`,`created_at`);--> statement-breakpoint
ALTER TABLE `current_prices` ADD `contested_report_id` text REFERENCES price_reports(id);--> statement-breakpoint
ALTER TABLE `price_reports` ADD `freshness_date` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `report_votes` ADD `weight` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `dismissed_flags_count` integer DEFAULT 0 NOT NULL;