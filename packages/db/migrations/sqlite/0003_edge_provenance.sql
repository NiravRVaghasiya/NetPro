ALTER TABLE `edges` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `edges` ADD `confidence` real DEFAULT 1;--> statement-breakpoint
ALTER TABLE `edges` ADD `status` text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_edges_source` ON `edges` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_edges_target` ON `edges` (`target_id`);--> statement-breakpoint
CREATE INDEX `idx_edges_relation` ON `edges` (`relation`);--> statement-breakpoint
CREATE INDEX `idx_edges_confidence` ON `edges` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_edges_status` ON `edges` (`status`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`location` text,
	`starts_at` text,
	`ends_at` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `event_attendees` (
	`event_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`role` text,
	`attended` integer DEFAULT true,
	`discovered_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `contact_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `idx_event_attendees_contact` ON `event_attendees` (`contact_id`);
