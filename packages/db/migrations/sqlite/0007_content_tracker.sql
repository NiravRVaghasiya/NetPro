CREATE TABLE `content_items` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`url_norm` text NOT NULL,
	`title` text NOT NULL,
	`platform` text NOT NULL,
	`type` text,
	`published_at` text,
	`author` text,
	`tags` text,
	`summary` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `content_items_url_norm_unique` UNIQUE(`url_norm`)
);
--> statement-breakpoint
CREATE TABLE `content_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`content_id` text NOT NULL,
	`fetched_at` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`bookmarks` integer,
	`raw_payload` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`content_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `content_mentions` (
	`content_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`context` text,
	PRIMARY KEY(`content_id`, `contact_id`),
	FOREIGN KEY (`content_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_content_items_platform` ON `content_items` (`platform`);--> statement-breakpoint
CREATE INDEX `idx_content_items_published` ON `content_items` (`published_at` DESC);--> statement-breakpoint
CREATE INDEX `idx_content_metrics_item_time` ON `content_metrics` (`content_id`, `fetched_at` DESC);--> statement-breakpoint
CREATE INDEX `idx_content_metrics_time` ON `content_metrics` (`fetched_at` DESC);--> statement-breakpoint
CREATE INDEX `idx_content_mentions_contact` ON `content_mentions` (`contact_id`);--> statement-breakpoint
CREATE INDEX `idx_content_mentions_content` ON `content_mentions` (`content_id`);
