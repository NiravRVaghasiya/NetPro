-- v3.0 Phase 2 — backfill any `workspace_id` rows that were written without a
-- workspace so the single-owner compatibility guarantee holds.
--
-- SQLite cannot `ALTER COLUMN ... SET DEFAULT`, but Drizzle's
-- `.default('default')` is client-side on SQLite (it substitutes the value at
-- insert time), so new Drizzle writes already land in the bootstrap workspace.
-- This migration only needs to repair rows that were inserted by raw SQL (or
-- during the window between 0008 and 0011) with a NULL workspace, so they are
-- not silently hidden by the Phase 2 `workspace_id = 'default'` predicates.
--
-- Additive and idempotent: the backfill only touches NULL rows.
UPDATE `contacts` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `interactions` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `edges` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `events` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `event_attendees` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `content_items` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `content_metrics` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `content_mentions` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `enrichments` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `campaigns` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `campaign_recipients` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `search_index` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `profile_views` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `follow_ups` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `activity_log` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `profile_cards` SET `workspace_id` = 'default' WHERE `workspace_id` IS NULL;
