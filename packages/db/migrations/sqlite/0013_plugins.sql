-- v3.0 Phase 5 — plugin runtime & manifest.
-- Additive table for workspace-scoped plugin installs. No FK to users beyond
-- installed_by_user text to avoid hard coupling — users may be deleted from
-- Auth.js tables while audit trail remains.
CREATE TABLE "plugins" (
 "id" text PRIMARY KEY NOT NULL,
 "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
 "name" text NOT NULL,
 "version" text NOT NULL,
 "manifest" text NOT NULL,
 "enabled" integer NOT NULL DEFAULT 0,
 "installed_from" text,
 "installed_by_user" text,
 "plugin_settings" text,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_workspace_name_unique" ON "plugins" ("workspace_id", "name");
--> statement-breakpoint
CREATE INDEX "idx_plugins_workspace" ON "plugins" ("workspace_id");
--> statement-breakpoint
CREATE INDEX "idx_plugins_workspace_enabled" ON "plugins" ("workspace_id", "enabled");
