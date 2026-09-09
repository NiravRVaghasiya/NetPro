-- v3.0 Phase 2 — give every workspace-scoped data table a real DB-level default.
--
-- Phase 1 (0008) added `workspace_id` as a *nullable* column and backfilled
-- existing rows, but never attached a DEFAULT. Drizzle's `.default('default')`
-- is client-side on SQLite and the `DEFAULT` keyword on Postgres — so on a real
-- server any insert that omits `workspace_id` produces NULL (there is no
-- column default to fall back to). Once Phase 2 scopes core reads to
-- `workspace_id = 'default'`, those NULL rows are invisible, which breaks the
-- single-owner compatibility guarantee (v2.5 had no workspace column at all).
--
-- This migration closes the gap:
--   1. `ALTER COLUMN ... SET DEFAULT 'default'` so future Postgres inserts that
--      rely on Drizzle's `DEFAULT` keyword actually land in the bootstrap
--      workspace.
--   2. a backfill for any rows that were written after 0008 (or by raw SQL)
--      without a workspace, so they belong to the bootstrap workspace again.
--
-- Additive and idempotent: setting a default is a no-op if already set, and
-- the backfill only touches NULL rows.
ALTER TABLE "contacts" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "interactions" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "edges" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "event_attendees" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "content_items" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "content_metrics" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "content_mentions" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "enrichments" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "campaign_recipients" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "search_index" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "profile_views" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "follow_ups" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "activity_log" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "profile_cards" ALTER COLUMN "workspace_id" SET DEFAULT 'default';--> statement-breakpoint
UPDATE "contacts" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "interactions" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "edges" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "events" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "event_attendees" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "content_items" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "content_metrics" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "content_mentions" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "enrichments" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "campaigns" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "campaign_recipients" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "search_index" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "profile_views" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "follow_ups" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "activity_log" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "profile_cards" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;
