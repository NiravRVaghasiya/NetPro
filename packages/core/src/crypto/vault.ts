import { randomUUID } from "node:crypto";
import { and, eq, isNull, isNotNull, or } from "drizzle-orm";
import type { PgConn, SqliteConn } from "@netpro/db";
import { canAtLeast, type WorkspaceScope } from "../workspaces";
import {
  decryptKey,
  encryptKey,
  vaultConfigured,
  vaultPrincipal,
  VaultError,
} from "./key-vault";
import { writeActivityLog } from "../crm/activity";

export const PROVIDER_KEYS = {
  "outreach.openai": "OPENAI_API_KEY",
  "outreach.anthropic": "ANTHROPIC_API_KEY",
  "enrichment.hunter": "HUNTER_API_KEY",
  "enrichment.pdl": "PDL_API_KEY",
  "enrichment.clearbit": "CLEARBIT_API_KEY",
  "embeddings.openai": "EMBEDDINGS_API_KEY",
  "content.devto": "DEVTO_API_KEY",
  "content.twitter": "TWITTER_BEARER_TOKEN",
  "content.github": "GITHUB_TOKEN",
} as const;
export type ProviderKey = keyof typeof PROVIDER_KEYS;
type Conn = SqliteConn | PgConn;
export type VaultTarget = "personal" | "workspace";

function authorize(scope: WorkspaceScope, target: VaultTarget, write = false) {
  if (!scope.userId || !scope.workspaceId || !canAtLeast(scope.role, "viewer"))
    throw new VaultError(403, "Workspace membership required.");
  if (target !== "personal" && target !== "workspace")
    throw new VaultError(400, "Invalid credential target.");
  if (
    write &&
    !canAtLeast(scope.role, target === "workspace" ? "admin" : "member")
  )
    throw new VaultError(403, "Insufficient role to manage credentials.");
}
function validateName(name: string) {
  if (
    !Object.hasOwn(PROVIDER_KEYS, name) &&
    !/^plugin\.[a-z0-9][a-z0-9.-]{0,99}$/.test(name)
  )
    throw new VaultError(400, "Unknown provider slot.");
}
function predicate(
  conn: Conn,
  scope: WorkspaceScope,
  name: string,
  userId: string | null,
) {
  const t = conn.schema.keyVault;
  return and(
    eq(t.workspaceId, scope.workspaceId),
    eq(t.keyName, name),
    userId === null ? isNull(t.userId) : eq(t.userId, userId),
  );
}

/** Explicit projection: ciphertext is never part of a management payload. */
export async function listVaultKeys(conn: Conn, scope: WorkspaceScope) {
  authorize(scope, "personal");
  if (conn.dialect === "sqlite") {
    const t = conn.schema.keyVault;
    return conn.db
      .select({
        keyName: t.keyName,
        userId: t.userId,
        lastFour: t.lastFour,
        updatedAt: t.updatedAt,
        lastUsedAt: t.lastUsedAt,
      })
      .from(t)
      .where(
        and(
          eq(t.workspaceId, scope.workspaceId),
          or(eq(t.userId, scope.userId), isNull(t.userId)),
        ),
      );
  }
  const t = conn.schema.keyVault;
  return conn.db
    .select({
      keyName: t.keyName,
      userId: t.userId,
      lastFour: t.lastFour,
      updatedAt: t.updatedAt,
      lastUsedAt: t.lastUsedAt,
    })
    .from(t)
    .where(
      and(
        eq(t.workspaceId, scope.workspaceId),
        or(eq(t.userId, scope.userId), isNull(t.userId)),
      ),
    );
}

export async function saveVaultKey(
  conn: Conn,
  scope: WorkspaceScope,
  target: VaultTarget,
  name: string,
  secret: string,
  master: string | undefined,
) {
  authorize(scope, target, true);
  validateName(name);
  if (
    typeof secret !== "string" ||
    secret.trim().length < 8 ||
    secret.length > 4096
  )
    throw new VaultError(
      400,
      "Credential must be between 8 and 4096 characters.",
    );
  const userId = target === "personal" ? scope.userId : null;
  const ciphertext = encryptKey(
    secret,
    master,
    vaultPrincipal(scope.workspaceId, userId, name),
  );
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    workspaceId: scope.workspaceId,
    userId,
    keyName: name,
    ciphertext,
    lastFour: secret.slice(-4),
    createdAt: now,
    updatedAt: now,
  };
  // Partial conflict targets cover both unique indexes, including null user_id. Concurrent first writes cannot create duplicate credentials.
  if (conn.dialect === "sqlite") {
    const t = conn.schema.keyVault;
    await conn.db
      .insert(t)
      .values(row)
      .onConflictDoUpdate({
        target:
          target === "personal"
            ? [t.workspaceId, t.userId, t.keyName]
            : [t.workspaceId, t.keyName],
        targetWhere:
          target === "personal" ? isNotNull(t.userId) : isNull(t.userId),
        set: {
          ciphertext,
          lastFour: row.lastFour,
          updatedAt: now,
          lastUsedAt: null,
        },
      });
  } else {
    const t = conn.schema.keyVault;
    await conn.db
      .insert(t)
      .values(row)
      .onConflictDoUpdate({
        target:
          target === "personal"
            ? [t.workspaceId, t.userId, t.keyName]
            : [t.workspaceId, t.keyName],
        targetWhere:
          target === "personal" ? isNotNull(t.userId) : isNull(t.userId),
        set: {
          ciphertext,
          lastFour: row.lastFour,
          updatedAt: now,
          lastUsedAt: null,
        },
      });
  }
  // Best-effort audit (never key material — slot name and target only).
  await writeActivityLog(
    conn,
    {
      action: "credential.saved",
      entityType: "credential",
      entityId: name,
      metadata: { target },
    },
    scope,
  );
}

export async function removeVaultKey(
  conn: Conn,
  scope: WorkspaceScope,
  target: VaultTarget,
  name: string,
  master: string | undefined,
) {
  authorize(scope, target, true);
  validateName(name);
  if (!vaultConfigured(master))
    throw new VaultError(503, "Key vault is read-only.");
  const where = predicate(
    conn,
    scope,
    name,
    target === "personal" ? scope.userId : null,
  );
  if (conn.dialect === "sqlite")
    await conn.db.delete(conn.schema.keyVault).where(where);
  else await conn.db.delete(conn.schema.keyVault).where(where);
  // Best-effort audit (never key material — slot name and target only).
  await writeActivityLog(
    conn,
    {
      action: "credential.removed",
      entityType: "credential",
      entityId: name,
      metadata: { target },
    },
    scope,
  );
}

/** Server-only credential use. A corrupt configured vault fails closed; only
 * an absent master intentionally uses env-only read-only compatibility mode. */
export async function resolveVaultKey(
  conn: Conn,
  scope: WorkspaceScope,
  name: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  authorize(scope, "personal");
  validateName(name);
  if (vaultConfigured(env.ENCRYPTION_MASTER_KEY)) {
    for (const userId of [scope.userId, null]) {
      const where = predicate(conn, scope, name, userId);
      const rows =
        conn.dialect === "sqlite"
          ? await conn.db
              .select()
              .from(conn.schema.keyVault)
              .where(where)
              .limit(1)
          : await conn.db
              .select()
              .from(conn.schema.keyVault)
              .where(where)
              .limit(1);
      const row = rows[0];
      if (!row) continue;
      const secret = decryptKey(
        row.ciphertext,
        env.ENCRYPTION_MASTER_KEY,
        vaultPrincipal(scope.workspaceId, userId, name),
      );
      const update = { lastUsedAt: new Date().toISOString() };
      if (conn.dialect === "sqlite")
        await conn.db.update(conn.schema.keyVault).set(update).where(where);
      else await conn.db.update(conn.schema.keyVault).set(update).where(where);
      return secret;
    }
  }
  const envName = PROVIDER_KEYS[name as ProviderKey];
  return (envName ? env[envName]?.trim() : undefined) || null;
}
