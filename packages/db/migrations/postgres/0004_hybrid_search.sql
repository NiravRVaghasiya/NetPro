ALTER TABLE "search_index" ADD COLUMN "embedding_dim" integer;--> statement-breakpoint
ALTER TABLE "search_index" ADD COLUMN "embedding_updated_at" text;--> statement-breakpoint
ALTER TABLE "search_index" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE INDEX "idx_search_index_updated_at" ON "search_index" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "search_index" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("search_text", ''))) STORED;--> statement-breakpoint
CREATE INDEX "idx_search_index_vector" ON "search_index" USING gin ("search_vector");
