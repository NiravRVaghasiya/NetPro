CREATE TABLE "content_items" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"url_norm" text NOT NULL,
	"title" text NOT NULL,
	"platform" text NOT NULL,
	"type" text,
	"published_at" text,
	"author" text,
	"tags" text,
	"summary" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "content_items_url_norm_unique" UNIQUE("url_norm")
);
--> statement-breakpoint
CREATE TABLE "content_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"content_id" text NOT NULL,
	"fetched_at" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"views" integer,
	"likes" integer,
	"comments" integer,
	"shares" integer,
	"bookmarks" integer,
	"raw_payload" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_metrics" ADD CONSTRAINT "content_metrics_content_id_content_items_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "content_mentions" (
	"content_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"context" text,
	CONSTRAINT "content_mentions_content_id_contact_id_pk" PRIMARY KEY("content_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "content_mentions" ADD CONSTRAINT "content_mentions_content_id_content_items_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_mentions" ADD CONSTRAINT "content_mentions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_items_platform" ON "content_items" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "idx_content_items_published" ON "content_items" USING btree ("published_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_content_metrics_item_time" ON "content_metrics" USING btree ("content_id","fetched_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_content_metrics_time" ON "content_metrics" USING btree ("fetched_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_content_mentions_contact" ON "content_mentions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_content_mentions_content" ON "content_mentions" USING btree ("content_id");
