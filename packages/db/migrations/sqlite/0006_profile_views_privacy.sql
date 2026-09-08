ALTER TABLE `profile_views` ADD `viewer_fingerprint` text;--> statement-breakpoint
ALTER TABLE `profile_views` ADD `is_bot` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `profile_views` ADD `is_owner_view` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `profile_views` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `profile_views` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `profile_views` ADD `utm_source` text;--> statement-breakpoint
ALTER TABLE `profile_views` ADD `utm_medium` text;--> statement-breakpoint
ALTER TABLE `profile_views` ADD `utm_campaign` text;--> statement-breakpoint
ALTER TABLE `profile_views` ADD `viewed_card_id` text;--> statement-breakpoint
UPDATE `profile_views` SET `viewer_ip` = NULL;--> statement-breakpoint
CREATE INDEX `idx_profile_views_time` ON `profile_views` (`viewed_at` DESC);--> statement-breakpoint
CREATE INDEX `idx_profile_views_resolved` ON `profile_views` (`resolved_contact`) WHERE `resolved_contact` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_profile_views_page` ON `profile_views` (`viewed_page`);--> statement-breakpoint
CREATE INDEX `idx_profile_views_fingerprint_time` ON `profile_views` (`viewer_fingerprint`, `viewed_at`);--> statement-breakpoint
CREATE INDEX `idx_profile_views_is_bot` ON `profile_views` (`viewed_at`) WHERE `is_bot` = false;
