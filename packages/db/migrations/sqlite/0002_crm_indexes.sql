CREATE INDEX `idx_campaign_recipients_status` ON `campaign_recipients` (`campaign_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_campaign_recipients_scheduled` ON `campaign_recipients` (`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_campaigns_status` ON `campaigns` (`status`);--> statement-breakpoint
CREATE INDEX `idx_contacts_relationship_score` ON `contacts` (`relationship_score`);--> statement-breakpoint
CREATE INDEX `idx_contacts_last_interaction` ON `contacts` (`last_interaction`);--> statement-breakpoint
CREATE INDEX `idx_followups_due` ON `follow_ups` (`due_at`);--> statement-breakpoint
CREATE INDEX `idx_followups_contact` ON `follow_ups` (`contact_id`);--> statement-breakpoint
CREATE INDEX `idx_interactions_contact` ON `interactions` (`contact_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_interactions_campaign` ON `interactions` (`campaign_id`);