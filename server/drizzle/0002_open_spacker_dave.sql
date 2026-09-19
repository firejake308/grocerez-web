CREATE TABLE `parse_spend_daily` (
	`day` text PRIMARY KEY NOT NULL,
	`cost_cents` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `report_photos` (
	`report_id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
