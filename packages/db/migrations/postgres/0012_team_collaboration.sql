-- v3.0 Phase 3 — team collaboration surface.
-- Adds `assigned_to` to follow_ups for per-member assignment (nullable user id;
-- null = unassigned / anyone). No FK to users to avoid hard coupling — users
-- may be deleted from Auth.js tables while follow-ups remain; unassigned
-- fallback is handled in application logic on member removal.
-- Additive and idempotent.
ALTER TABLE "follow_ups" ADD COLUMN IF NOT EXISTS "assigned_to" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_followups_assigned_to" ON "follow_ups" ("assigned_to");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_followups_workspace_assigned" ON "follow_ups" ("workspace_id", "assigned_to");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_followups_workspace_status_assigned_due" ON "follow_ups" ("workspace_id", "status", "assigned_to", "due_at");
