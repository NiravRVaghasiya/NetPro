ALTER TABLE "interactions" ADD COLUMN "created_by_user" text;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD COLUMN "created_by_user" text;--> statement-breakpoint
CREATE INDEX "idx_interactions_author" ON "interactions" USING btree ("created_by_user");--> statement-breakpoint
CREATE INDEX "idx_followups_author" ON "follow_ups" USING btree ("created_by_user");
