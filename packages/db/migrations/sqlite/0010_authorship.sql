ALTER TABLE `interactions` ADD `created_by_user` text;--> statement-breakpoint
ALTER TABLE `follow_ups` ADD `created_by_user` text;--> statement-breakpoint
CREATE INDEX `idx_interactions_author` ON `interactions` (`created_by_user`);--> statement-breakpoint
CREATE INDEX `idx_followups_author` ON `follow_ups` (`created_by_user`);
