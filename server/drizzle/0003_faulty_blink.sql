CREATE TABLE `credit_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credits` integer NOT NULL,
	`access_from` text NOT NULL,
	`access_until` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `credit_redemptions_user_idx` ON `credit_redemptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `contribution_credits` ADD `spent_redemption_id` text REFERENCES credit_redemptions(id);--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `cancel_at_period_end` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `last_event_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_provider_ref_unique` ON `subscriptions` (`provider_ref`);--> statement-breakpoint
ALTER TABLE `users` ADD `stripe_customer_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `credit_access_until` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_stripe_customer_unique` ON `users` (`stripe_customer_id`);