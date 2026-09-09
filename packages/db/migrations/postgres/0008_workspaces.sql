CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_unique" ON "workspaces" USING btree ("slug");--> statement-breakpoint
INSERT INTO "workspaces" ("id", "name", "slug", "created_at") VALUES ('default', 'Personal', 'default', CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_user_unique" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_members_workspace" ON "workspace_members" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_members_user" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE "workspace_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"token" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"expires_at" text NOT NULL,
	"created_by" text,
	"accepted_at" text,
	"revoked_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invites_token_unique" ON "workspace_invites" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_workspace_invites_workspace" ON "workspace_invites" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_invites_expires" ON "workspace_invites" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "content_metrics" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "content_mentions" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "enrichments" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "search_index" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "profile_views" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "profile_cards" ADD COLUMN "workspace_id" text;--> statement-breakpoint
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
UPDATE "profile_cards" SET "workspace_id" = 'default' WHERE "workspace_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_contacts_workspace" ON "contacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_contacts_workspace_updated" ON "contacts" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_interactions_workspace" ON "interactions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_interactions_workspace_contact" ON "interactions" USING btree ("workspace_id","contact_id");--> statement-breakpoint
CREATE INDEX "idx_edges_workspace" ON "edges" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_events_workspace" ON "events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_event_attendees_workspace" ON "event_attendees" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_content_items_workspace" ON "content_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_content_metrics_workspace" ON "content_metrics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_content_mentions_workspace" ON "content_mentions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_enrichments_workspace" ON "enrichments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_campaigns_workspace" ON "campaigns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_campaign_recipients_workspace" ON "campaign_recipients" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_search_index_workspace" ON "search_index" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_profile_views_workspace" ON "profile_views" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_profile_views_workspace_time" ON "profile_views" USING btree ("workspace_id","viewed_at");--> statement-breakpoint
CREATE INDEX "idx_followups_workspace" ON "follow_ups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_followups_workspace_status_due" ON "follow_ups" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE INDEX "idx_activity_log_workspace" ON "activity_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_activity_log_workspace_time" ON "activity_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_profile_cards_workspace" ON "profile_cards" USING btree ("workspace_id");
