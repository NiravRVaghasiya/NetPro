-- v3.0 Phase 7 — outbound webhooks with HMAC-SHA256 signatures,
-- retry with backoff and dead-lettering, delivery logs, and receiver recipes
-- for Zapier, n8n, and Make. Outbound only in v3.0.
CREATE TABLE IF NOT EXISTS "webhooks" (
 "id" text PRIMARY KEY NOT NULL,
 "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
 "url" text NOT NULL,
 "secret" text NOT NULL,
 "event_allowlist" text NOT NULL DEFAULT '',
 "status" text NOT NULL DEFAULT 'paused',
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
 "id" text PRIMARY KEY NOT NULL,
 "webhook_id" text NOT NULL REFERENCES "webhooks"("id") ON DELETE CASCADE,
 "event" text NOT NULL,
 "payload" text NOT NULL,
 "status" text NOT NULL DEFAULT 'pending',
 "received_at" timestamp with time zone,
 "response_code" integer,
 "error_message" text,
 "attempt" integer NOT NULL DEFAULT 1,
 "max_attempts" integer NOT NULL DEFAULT 8,
 "created_at" timestamp with time zone NOT NULL,
 "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhooks_workspace" ON "webhooks" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhooks_status" ON "webhooks" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_webhook" ON "webhook_deliveries" ("webhook_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_status" ON "webhook_deliveries" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_attempt" ON "webhook_deliveries" ("attempt");
