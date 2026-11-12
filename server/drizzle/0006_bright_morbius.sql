CREATE TABLE `product_search_counts` (
	`product_id` text NOT NULL,
	`day` text NOT NULL,
	`located` integer NOT NULL,
	`cell_lat` real DEFAULT 0 NOT NULL,
	`cell_lon` real DEFAULT 0 NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`product_id`, `day`, `located`, `cell_lat`, `cell_lon`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `product_search_counts_day_idx` ON `product_search_counts` (`day`);