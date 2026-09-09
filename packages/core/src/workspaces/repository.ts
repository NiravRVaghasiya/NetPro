// packages/core/src/workspaces/repository.ts
// Core persistence for workspaces, members, and invites.
// Dual-dialect, portable SQL where possible, Drizzle for writes.
// Every data mutation stamps workspace_id; reads are explicitly scoped in Phase 2,
// but this module already enforces workspace isolation.

import { eq, and } from 'drizzle-orm';
import type { PgConn, SqliteConn } from '@netpro/db';
import {
  WorkspaceError,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceInvite,
  type WorkspaceRole,
  WORKSPACE_ROLES,
  WORKSPACE_LIMITS,
  isWorkspaceRole,
  resolveNow,
} from './types';
import { createInviteToken } from './tokens';

type Conn = SqliteConn | PgConn;

const BOOTSTRAP_WORKSPACE_ID = 'default';
const BOOTSTRAP_SLUG = 'default';
const BOOTSTRAP_NAME = 'Personal';

function assertNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new WorkspaceError('invalid_input', `${field} is required.`);
  return trimmed;
}

function assertSlug(slug: string): string {
  const trimmed = slug.trim().toLowerCase();
  if (!trimmed) throw new WorkspaceError('invalid_input', 'slug is required.');
  if (trimmed.length > WORKSPACE_LIMITS.slug) {
    throw new WorkspaceError('invalid_input', `slug must be ${WORKSPACE_LIMITS.slug} chars or fewer.`);
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(trimmed)) {
    throw new WorkspaceError('invalid_input', 'slug must be alphanumeric with dashes/underscores, starting with alphanumeric.');
  }
  return trimmed;
}

function assertRole(role: unknown): WorkspaceRole {
  if (!isWorkspaceRole(role)) {
    throw new WorkspaceError('invalid_input', `role must be one of ${WORKSPACE_ROLES.join(', ')}.`);
  }
  return role;
}

function randomId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export async function ensureBootstrapWorkspace(conn: Conn): Promise<Workspace> {
  const now = new Date().toISOString();
  // Drizzle upsert
  if (conn.dialect === 'sqlite') {
    await conn.db
      .insert(conn.schema.workspaces)
      .values({
        id: BOOTSTRAP_WORKSPACE_ID,
        name: BOOTSTRAP_NAME,
        slug: BOOTSTRAP_SLUG,
        createdAt: now,
      })
      .onConflictDoNothing({ target: conn.schema.workspaces.id });
    const rows = await conn.db
      .select()
      .from(conn.schema.workspaces)
      .where(eq(conn.schema.workspaces.id, BOOTSTRAP_WORKSPACE_ID))
      .limit(1);
    if (!rows[0]) throw new WorkspaceError('not_found', 'Bootstrap workspace missing after upsert.');
    return rows[0] as Workspace;
  } else {
    await conn.db
      .insert(conn.schema.workspaces)
      .values({
        id: BOOTSTRAP_WORKSPACE_ID,
        name: BOOTSTRAP_NAME,
        slug: BOOTSTRAP_SLUG,
        createdAt: now,
      })
      .onConflictDoNothing({ target: conn.schema.workspaces.id });
    const rows = await conn.db
      .select()
      .from(conn.schema.workspaces)
      .where(eq(conn.schema.workspaces.id, BOOTSTRAP_WORKSPACE_ID))
      .limit(1);
    if (!rows[0]) throw new WorkspaceError('not_found', 'Bootstrap workspace missing after upsert.');
    return rows[0] as Workspace;
  }
}

export async function getWorkspaceById(conn: Conn, id: string): Promise<Workspace | null> {
  const trimmed = assertNonEmpty(id, 'workspace id');
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db.select().from(conn.schema.workspaces).where(eq(conn.schema.workspaces.id, trimmed)).limit(1)
      : await conn.db.select().from(conn.schema.workspaces).where(eq(conn.schema.workspaces.id, trimmed)).limit(1);
  return (rows[0] as Workspace) ?? null;
}

export async function getWorkspaceBySlug(conn: Conn, slug: string): Promise<Workspace | null> {
  const s = assertSlug(slug);
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db.select().from(conn.schema.workspaces).where(eq(conn.schema.workspaces.slug, s)).limit(1)
      : await conn.db.select().from(conn.schema.workspaces).where(eq(conn.schema.workspaces.slug, s)).limit(1);
  return (rows[0] as Workspace) ?? null;
}

export async function listWorkspaces(conn: Conn): Promise<Workspace[]> {
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db.select().from(conn.schema.workspaces)
      : await conn.db.select().from(conn.schema.workspaces);
  return rows as Workspace[];
}

export async function createWorkspace(
  conn: Conn,
  input: { name: string; slug: string },
): Promise<Workspace> {
  const name = assertNonEmpty(input.name, 'name');
  if (name.length > WORKSPACE_LIMITS.name) {
    throw new WorkspaceError('invalid_input', `name must be ${WORKSPACE_LIMITS.name} chars or fewer.`);
  }
  const slug = assertSlug(input.slug);
  const id = randomId();
  const now = new Date().toISOString();
  try {
    const rows =
      conn.dialect === 'sqlite'
        ? await conn.db
            .insert(conn.schema.workspaces)
            .values({ id, name, slug, createdAt: now })
            .returning()
        : await conn.db
            .insert(conn.schema.workspaces)
            .values({ id, name, slug, createdAt: now })
            .returning();
    return rows[0] as Workspace;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
      throw new WorkspaceError('conflict', `Workspace slug "${slug}" already exists.`);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function getWorkspaceMembers(conn: Conn, workspaceId: string): Promise<WorkspaceMember[]> {
  const ws = assertNonEmpty(workspaceId, 'workspaceId');
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db.select().from(conn.schema.workspaceMembers).where(eq(conn.schema.workspaceMembers.workspaceId, ws))
      : await conn.db.select().from(conn.schema.workspaceMembers).where(eq(conn.schema.workspaceMembers.workspaceId, ws));
  return rows as WorkspaceMember[];
}

export async function getMember(
  conn: Conn,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMember | null> {
  const ws = assertNonEmpty(workspaceId, 'workspaceId');
  const uid = assertNonEmpty(userId, 'userId');
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db
          .select()
          .from(conn.schema.workspaceMembers)
          .where(and(eq(conn.schema.workspaceMembers.workspaceId, ws), eq(conn.schema.workspaceMembers.userId, uid)))
          .limit(1)
      : await conn.db
          .select()
          .from(conn.schema.workspaceMembers)
          .where(and(eq(conn.schema.workspaceMembers.workspaceId, ws), eq(conn.schema.workspaceMembers.userId, uid)))
          .limit(1);
  return (rows[0] as WorkspaceMember) ?? null;
}

export async function getMemberByUserId(conn: Conn, userId: string): Promise<WorkspaceMember | null> {
  const uid = assertNonEmpty(userId, 'userId');
  // For v3.0 single-workspace UI, return first membership (bootstrap).
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db
          .select()
          .from(conn.schema.workspaceMembers)
          .where(eq(conn.schema.workspaceMembers.userId, uid))
          .limit(1)
      : await conn.db
          .select()
          .from(conn.schema.workspaceMembers)
          .where(eq(conn.schema.workspaceMembers.userId, uid))
          .limit(1);
  return (rows[0] as WorkspaceMember) ?? null;
}

export async function listMembersByUserId(conn: Conn, userId: string): Promise<WorkspaceMember[]> {
  const uid = assertNonEmpty(userId, 'userId');
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db.select().from(conn.schema.workspaceMembers).where(eq(conn.schema.workspaceMembers.userId, uid))
      : await conn.db.select().from(conn.schema.workspaceMembers).where(eq(conn.schema.workspaceMembers.userId, uid));
  return rows as WorkspaceMember[];
}

export async function addMember(
  conn: Conn,
  input: { workspaceId: string; userId: string; role?: WorkspaceRole },
  opts: { now?: Date } = {},
): Promise<WorkspaceMember> {
  const ws = assertNonEmpty(input.workspaceId, 'workspaceId');
  const uid = assertNonEmpty(input.userId, 'userId');
  const role = input.role ? assertRole(input.role) : 'member';
  const id = randomId();
  const now = resolveNow(opts.now).toISOString();
  try {
    const rows =
      conn.dialect === 'sqlite'
        ? await conn.db
            .insert(conn.schema.workspaceMembers)
            .values({ id, workspaceId: ws, userId: uid, role, createdAt: now })
            .returning()
        : await conn.db
            .insert(conn.schema.workspaceMembers)
            .values({ id, workspaceId: ws, userId: uid, role, createdAt: now })
            .returning();
    return rows[0] as WorkspaceMember;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
      throw new WorkspaceError('conflict', 'User is already a member of this workspace.');
    }
    throw e;
  }
}

export async function updateMemberRole(
  conn: Conn,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<WorkspaceMember> {
  const ws = assertNonEmpty(workspaceId, 'workspaceId');
  const uid = assertNonEmpty(userId, 'userId');
  const r = assertRole(role);
  // Prevent removing last owner is enforced in service layer, not here.
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db
          .update(conn.schema.workspaceMembers)
          .set({ role: r })
          .where(and(eq(conn.schema.workspaceMembers.workspaceId, ws), eq(conn.schema.workspaceMembers.userId, uid)))
          .returning()
      : await conn.db
          .update(conn.schema.workspaceMembers)
          .set({ role: r })
          .where(and(eq(conn.schema.workspaceMembers.workspaceId, ws), eq(conn.schema.workspaceMembers.userId, uid)))
          .returning();
  if (!rows[0]) throw new WorkspaceError('not_found', 'Membership not found.');
  return rows[0] as WorkspaceMember;
}

export async function removeMember(conn: Conn, workspaceId: string, userId: string): Promise<void> {
  const ws = assertNonEmpty(workspaceId, 'workspaceId');
  const uid = assertNonEmpty(userId, 'userId');
  if (conn.dialect === 'sqlite') {
    await conn.db
      .delete(conn.schema.workspaceMembers)
      .where(and(eq(conn.schema.workspaceMembers.workspaceId, ws), eq(conn.schema.workspaceMembers.userId, uid)));
  } else {
    await conn.db
      .delete(conn.schema.workspaceMembers)
      .where(and(eq(conn.schema.workspaceMembers.workspaceId, ws), eq(conn.schema.workspaceMembers.userId, uid)));
  }
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export async function createInvite(
  conn: Conn,
  input: {
    workspaceId: string;
    role?: WorkspaceRole;
    createdBy?: string | null;
    expiresInDays?: number;
    secret: string;
  },
  opts: { now?: Date } = {},
): Promise<{ invite: WorkspaceInvite; rawToken: string }> {
  const ws = assertNonEmpty(input.workspaceId, 'workspaceId');
  if (!input.secret) throw new WorkspaceError('invalid_input', 'secret is required for invite tokens.');
  const role = input.role ? assertRole(input.role) : 'member';
  const days = input.expiresInDays ?? 7;
  if (!Number.isFinite(days) || days <= 0 || days > 30) {
    throw new WorkspaceError('invalid_input', 'expiresInDays must be 1-30.');
  }
  const now = resolveNow(opts.now);
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const id = randomId();
  const rawToken = createInviteToken(id, expiresAt, input.secret);
  // Store only the raw token? Plan says token HMAC-signed; we store token as signed value.
  // The token column holds the signed token (unique).
  const createdAt = now.toISOString();
  const values = {
    id,
    workspaceId: ws,
    token: rawToken,
    role,
    expiresAt: expiresAt.toISOString(),
    createdBy: input.createdBy ?? null,
    acceptedAt: null,
    revokedAt: null,
    createdAt,
  };
  try {
    const rows =
      conn.dialect === 'sqlite'
        ? await conn.db.insert(conn.schema.workspaceInvites).values(values).returning()
        : await conn.db.insert(conn.schema.workspaceInvites).values(values).returning();
    return { invite: rows[0] as WorkspaceInvite, rawToken };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
      throw new WorkspaceError('conflict', 'Invite token collision, retry.');
    }
    throw e;
  }
}

export async function getInviteById(conn: Conn, id: string): Promise<WorkspaceInvite | null> {
  const trimmed = assertNonEmpty(id, 'invite id');
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db.select().from(conn.schema.workspaceInvites).where(eq(conn.schema.workspaceInvites.id, trimmed)).limit(1)
      : await conn.db.select().from(conn.schema.workspaceInvites).where(eq(conn.schema.workspaceInvites.id, trimmed)).limit(1);
  return (rows[0] as WorkspaceInvite) ?? null;
}

export async function getInviteByToken(conn: Conn, token: string): Promise<WorkspaceInvite | null> {
  const trimmed = assertNonEmpty(token, 'token');
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db.select().from(conn.schema.workspaceInvites).where(eq(conn.schema.workspaceInvites.token, trimmed)).limit(1)
      : await conn.db.select().from(conn.schema.workspaceInvites).where(eq(conn.schema.workspaceInvites.token, trimmed)).limit(1);
  return (rows[0] as WorkspaceInvite) ?? null;
}

export async function listInvites(conn: Conn, workspaceId: string): Promise<WorkspaceInvite[]> {
  const ws = assertNonEmpty(workspaceId, 'workspaceId');
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db.select().from(conn.schema.workspaceInvites).where(eq(conn.schema.workspaceInvites.workspaceId, ws))
      : await conn.db.select().from(conn.schema.workspaceInvites).where(eq(conn.schema.workspaceInvites.workspaceId, ws));
  return rows as WorkspaceInvite[];
}

export async function acceptInvite(
  conn: Conn,
  inviteId: string,
  opts: { now?: Date } = {},
): Promise<WorkspaceInvite> {
  const now = resolveNow(opts.now).toISOString();
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db
          .update(conn.schema.workspaceInvites)
          .set({ acceptedAt: now })
          .where(eq(conn.schema.workspaceInvites.id, inviteId))
          .returning()
      : await conn.db
          .update(conn.schema.workspaceInvites)
          .set({ acceptedAt: now })
          .where(eq(conn.schema.workspaceInvites.id, inviteId))
          .returning();
  if (!rows[0]) throw new WorkspaceError('not_found', 'Invite not found.');
  return rows[0] as WorkspaceInvite;
}

export async function revokeInvite(
  conn: Conn,
  inviteId: string,
  opts: { now?: Date } = {},
): Promise<WorkspaceInvite> {
  const now = resolveNow(opts.now).toISOString();
  const rows =
    conn.dialect === 'sqlite'
      ? await conn.db
          .update(conn.schema.workspaceInvites)
          .set({ revokedAt: now })
          .where(eq(conn.schema.workspaceInvites.id, inviteId))
          .returning()
      : await conn.db
          .update(conn.schema.workspaceInvites)
          .set({ revokedAt: now })
          .where(eq(conn.schema.workspaceInvites.id, inviteId))
          .returning();
  if (!rows[0]) throw new WorkspaceError('not_found', 'Invite not found.');
  return rows[0] as WorkspaceInvite;
}

export async function deleteInvite(conn: Conn, inviteId: string): Promise<void> {
  const trimmed = assertNonEmpty(inviteId, 'inviteId');
  if (conn.dialect === 'sqlite') {
    await conn.db.delete(conn.schema.workspaceInvites).where(eq(conn.schema.workspaceInvites.id, trimmed));
  } else {
    await conn.db.delete(conn.schema.workspaceInvites).where(eq(conn.schema.workspaceInvites.id, trimmed));
  }
}
