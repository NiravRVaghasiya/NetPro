ALTER TABLE "profile_views" ADD COLUMN "viewer_fingerprint" text;--> statement-breakpoint
ALTER TABLE "profile_views" ADD COLUMN "is_bot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_views" ADD COLUMN "is_owner_view" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_views" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "profile_views" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "profile_views" ADD COLUMN "utm_source" text;--> statement-breakpoint
ALTER TABLE "profile_views" ADD COLUMN "utm_medium" text;--> statement-breakpoint
ALTER TABLE "profile_views" ADD COLUMN "utm_campaign" text;--> statement-breakpoint
ALTER TABLE "profile_views" ADD COLUMN "viewed_card_id" text;--> statement-breakpoint
UPDATE "profile_views" SET "viewer_ip" = NULL;--> statement-breakpoint
CREATE INDEX "idx_profile_views_time" ON "profile_views" USING btree ("viewed_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_profile_views_resolved" ON "profile_views" USING btree ("resolved_contact") WHERE "resolved_contact" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_profile_views_page" ON "profile_views" USING btree ("viewed_page");--> statement-breakpoint
CREATE INDEX "idx_profile_views_fingerprint_time" ON "profile_views" USING btree ("viewer_fingerprint","viewed_at");--> statement-breakpoint
CREATE INDEX "idx_profile_views_is_bot" ON "profile_views" USING btree ("viewed_at") WHERE "is_bot" = false;
