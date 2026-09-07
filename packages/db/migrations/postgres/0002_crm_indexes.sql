CREATE INDEX "idx_campaign_recipients_status" ON "campaign_recipients" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "idx_campaign_recipients_scheduled" ON "campaign_recipients" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_campaigns_status" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_contacts_relationship_score" ON "contacts" USING btree ("relationship_score");--> statement-breakpoint
CREATE INDEX "idx_contacts_last_interaction" ON "contacts" USING btree ("last_interaction");--> statement-breakpoint
CREATE INDEX "idx_followups_due" ON "follow_ups" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "idx_followups_contact" ON "follow_ups" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_interactions_contact" ON "interactions" USING btree ("contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_interactions_campaign" ON "interactions" USING btree ("campaign_id");