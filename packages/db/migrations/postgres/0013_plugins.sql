-- v3.0 Phase 5 — plugin runtime & manifest.
-- Additive table for workspace-scoped plugin installs.
CREATE TABLE IF NOT EXISTS "plugins" (
 "id" text PRIMARY KEY NOT NULL,
 "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
 "name" text NOT NULL,
 "version" text NOT NULL,
 "manifest" text NOT NULL,
 "enabled" boolean NOT NULL DEFAULT false,
 "installed_from" text,
 "installed_by_user" text,
 "plugin_settings" text,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugins_workspace_name_unique" ON "plugins" ("workspace_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_plugins_workspace" ON "plugins" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_plugins_workspace_enabled" ON "plugins" ("workspace_id", "enabled");
