// apps/web/lib/workspaces.ts
// v3.0 Phase 1 — workspace membership resolution (Node runtime, uses DB).
// This file is NOT edge-safe — it imports @netpro/db and core.

import { eq, and } from "drizzle-orm";
import { conn } from "./db";
import type { WorkspaceRole } from "@netpro/core/src/workspaces";

export interface Membership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export async function getUserByGitHubId(
  githubId: string,
): Promise<{ id: string } | null> {
  // Auth.js stores GitHub providerAccountId in account table.
  // We need to find user id via account.
  const rows =
    conn.dialect === "sqlite"
      ? await conn.db
          .select({ userId: conn.schema.accounts.userId })
          .from(conn.schema.accounts)
          .where(
            and(
              eq(conn.schema.accounts.provider, "github"),
              eq(conn.schema.accounts.providerAccountId, githubId),
            ),
          )
          .limit(1)
      : await conn.db
          .select({ userId: conn.schema.accounts.userId })
          .from(conn.schema.accounts)
          .where(
            and(
              eq(conn.schema.accounts.provider, "github"),
              eq(conn.schema.accounts.providerAccountId, githubId),
            ),
          )
          .limit(1);
  if (!rows[0]) return null;
  return { id: rows[0].userId };
}

/**
 * Phase 5 — the local operator's `users` row.
 *
 * Local mode has no OAuth sign-in to create this row, but every membership /
 * activity-log / retention path is keyed by user id, so the installation
 * identity is projected here. Insert-only (`onConflictDoNothing`) so a name or
 * email edited in the database is never clobbered, and concurrent cold starts
 * cannot race.
 */
export async function ensureLocalOwnerUser(
  userId: string,
  name: string,
  email: string,
): Promise<void> {
  const values = { id: userId, name, email, emailVerified: null };
  if (conn.dialect === "sqlite") {
    await conn.db
      .insert(conn.schema.users)
      .values(values)
      .onConflictDoNothing({ target: conn.schema.users.id });
  } else {
    await conn.db
      .insert(conn.schema.users)
      .values(values)
      .onConflictDoNothing({ target: conn.schema.users.id });
  }
}

export async function getMembershipsForUser(
  userId: string,
): Promise<Membership[]> {
  const rows =
    conn.dialect === "sqlite"
      ? await conn.db
          .select()
          .from(conn.schema.workspaceMembers)
          .where(eq(conn.schema.workspaceMembers.userId, userId))
      : await conn.db
          .select()
          .from(conn.schema.workspaceMembers)
          .where(eq(conn.schema.workspaceMembers.userId, userId));
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    userId: r.userId,
    role: r.role as WorkspaceRole,
  }));
}

export async function getMembershipForUser(
  userId: string,
): Promise<Membership | null> {
  const all = await getMembershipsForUser(userId);
  if (all.length === 0) return null;
  // Prefer bootstrap workspace
  const bootstrap = all.find((m) => m.workspaceId === "default");
  return bootstrap ?? all[0] ?? null;
}

export async function ensureBootstrapWorkspaceExists(): Promise<void> {
  const now = new Date().toISOString();
  if (conn.dialect === "sqlite") {
    await conn.db
      .insert(conn.schema.workspaces)
      .values({
        id: "default",
        name: "Personal",
        slug: "default",
        createdAt: now,
      })
      .onConflictDoNothing({ target: conn.schema.workspaces.id });
  } else {
    await conn.db
      .insert(conn.schema.workspaces)
      .values({
        id: "default",
        name: "Personal",
        slug: "default",
        createdAt: now,
      })
      .onConflictDoNothing({ target: conn.schema.workspaces.id });
  }
}

export async function ensureOwnerMembership(userId: string): Promise<void> {
  await ensureBootstrapWorkspaceExists();
  const existing = await getMembershipForUser(userId);
  if (existing) {
    // Upgrade to owner if not already
    if (existing.role !== "owner") {
      if (conn.dialect === "sqlite") {
        await conn.db
          .update(conn.schema.workspaceMembers)
          .set({ role: "owner" })
          .where(
            and(
              eq(
                conn.schema.workspaceMembers.workspaceId,
                existing.workspaceId,
              ),
              eq(conn.schema.workspaceMembers.userId, userId),
            ),
          );
      } else {
        await conn.db
          .update(conn.schema.workspaceMembers)
          .set({ role: "owner" })
          .where(
            and(
              eq(
                conn.schema.workspaceMembers.workspaceId,
                existing.workspaceId,
              ),
              eq(conn.schema.workspaceMembers.userId, userId),
            ),
          );
      }
    }
    return;
  }
  // Create owner membership. `onConflictDoNothing` matters in local mode,
  // where the local operator's session (and therefore this call) is resolved
  // on every request: two concurrent requests must not fail the unique
  // (workspace_id, user_id) constraint against each other.
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  if (conn.dialect === "sqlite") {
    await conn.db
      .insert(conn.schema.workspaceMembers)
      .values({
        id,
        workspaceId: "default",
        userId,
        role: "owner",
        createdAt: now,
      })
      .onConflictDoNothing();
  } else {
    await conn.db
      .insert(conn.schema.workspaceMembers)
      .values({
        id,
        workspaceId: "default",
        userId,
        role: "owner",
        createdAt: now,
      })
      .onConflictDoNothing();
  }
}

export async function hasAnyMembers(): Promise<boolean> {
  const rows =
    conn.dialect === "sqlite"
      ? await conn.db
          .select({ id: conn.schema.workspaceMembers.id })
          .from(conn.schema.workspaceMembers)
          .limit(1)
      : await conn.db
          .select({ id: conn.schema.workspaceMembers.id })
          .from(conn.schema.workspaceMembers)
          .limit(1);
  return rows.length > 0;
}

export async function isUserMember(userId: string): Promise<boolean> {
  const m = await getMembershipForUser(userId);
  return Boolean(m);
}
