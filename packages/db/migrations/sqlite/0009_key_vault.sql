CREATE TABLE "key_vault" (
 "id" text PRIMARY KEY NOT NULL,
 "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
 "user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
 "key_name" text NOT NULL,
 "ciphertext" text NOT NULL,
 "last_four" text NOT NULL,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL,
 "last_used_at" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "key_vault_personal_unique" ON "key_vault" ("workspace_id", "user_id", "key_name") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "key_vault_workspace_unique" ON "key_vault" ("workspace_id", "key_name") WHERE "user_id" IS NULL;
