ALTER TABLE "edges" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "confidence" real DEFAULT 1;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "status" text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_edges_source" ON "edges" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_edges_target" ON "edges" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_edges_relation" ON "edges" USING btree ("relation");--> statement-breakpoint
CREATE INDEX "idx_edges_confidence" ON "edges" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "idx_edges_status" ON "edges" USING btree ("status");--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"starts_at" text,
	"ends_at" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" text NOT NULL
);--> statement-breakpoint
CREATE TABLE "event_attendees" (
	"event_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"role" text,
	"attended" boolean DEFAULT true,
	"discovered_at" text NOT NULL,
	CONSTRAINT "event_attendees_event_id_contact_id_pk" PRIMARY KEY("event_id","contact_id")
);--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_event_attendees_contact" ON "event_attendees" USING btree ("contact_id");
