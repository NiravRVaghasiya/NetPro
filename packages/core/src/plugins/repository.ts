// packages/core/src/plugins/repository.ts
// CRUD for plugins table, workspace-scoped.

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { resolveScope, workspacePredicate, type WorkspaceScope } from '../workspaces/scope';
import type { PluginManifest, PluginListItem } from './types';
import { PluginError } from './manifest';

type Conn = SqliteConn | PgConn;

function parseRow(row: {
  id: string;
  workspaceId: string;
  name: string;
  version: string;
  manifest: string;
  enabled: boolean | number | null;
  installedFrom: string | null;
  installedByUser: string | null;
  pluginSettings: string | null;
  createdAt: string;
  updatedAt: string;
}): PluginListItem {
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(row.manifest) as PluginManifest;
  } catch {
    // corrupted manifest — treat as invalid but still return row with fallback
    manifest = {
      name: row.name,
      version: row.version,
      engine: '*',
      permissions: { capabilities: [] },
    } as unknown as PluginManifest;
  }
  let settings: Record<string, unknown> | null = null;
  if (row.pluginSettings) {
    try {
      settings = JSON.parse(row.pluginSettings) as Record<string, unknown>;
    } catch {
      settings = null;
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    version: row.version,
    manifest,
    enabled: Boolean(row.enabled),
    installedFrom: row.installedFrom,
    installedByUser: row.installedByUser,
    settings,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listPlugins(conn: Conn, scope?: WorkspaceScope): Promise<PluginListItem[]> {
  const resolved = resolveScope(scope);
  if (conn.dialect === 'sqlite') {
    const t = conn.schema.plugins;
    const rows = await conn.db
      .select()
      .from(t)
      .where(workspacePredicate(resolved, t.workspaceId));
    return rows.map((r) =>
      parseRow({
        id: r.id,
        workspaceId: r.workspaceId,
        name: r.name,
        version: r.version,
        manifest: r.manifest,
        enabled: r.enabled as unknown as boolean,
        installedFrom: r.installedFrom ?? null,
        installedByUser: r.installedByUser ?? null,
        pluginSettings: r.pluginSettings ? JSON.stringify(r.pluginSettings) : null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })
    );
  }
  const t = conn.schema.plugins;
  const rows = await conn.db
    .select()
    .from(t)
    .where(workspacePredicate(resolved, t.workspaceId));
  return rows.map((r) =>
    parseRow({
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      version: r.version,
      manifest: r.manifest,
      enabled: r.enabled as unknown as boolean,
      installedFrom: r.installedFrom ?? null,
      installedByUser: r.installedByUser ?? null,
      pluginSettings: r.pluginSettings ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })
  );
}

export async function getPluginByName(conn: Conn, name: string, scope?: WorkspaceScope): Promise<PluginListItem | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const resolved = resolveScope(scope);
  if (conn.dialect === 'sqlite') {
    const t = conn.schema.plugins;
    const rows = await conn.db
      .select()
      .from(t)
      .where(and(eq(t.workspaceId, resolved.workspaceId), eq(t.name, trimmed)));
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return parseRow({
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      version: r.version,
      manifest: r.manifest,
      enabled: r.enabled as unknown as boolean,
      installedFrom: r.installedFrom ?? null,
      installedByUser: r.installedByUser ?? null,
      pluginSettings: r.pluginSettings ? JSON.stringify(r.pluginSettings) : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  }
  const t = conn.schema.plugins;
  const rows = await conn.db
    .select()
    .from(t)
    .where(and(eq(t.workspaceId, resolved.workspaceId), eq(t.name, trimmed)));
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return parseRow({
    id: r.id,
    workspaceId: r.workspaceId,
    name: r.name,
    version: r.version,
    manifest: r.manifest,
    enabled: r.enabled as unknown as boolean,
    installedFrom: r.installedFrom ?? null,
    installedByUser: r.installedByUser ?? null,
    pluginSettings: r.pluginSettings ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export async function createPlugin(
  conn: Conn,
  input: {
    name: string;
    version: string;
    manifest: PluginManifest;
    installedFrom?: string | null;
    installedByUser?: string | null;
    settings?: Record<string, unknown> | null;
  },
  scope?: WorkspaceScope
): Promise<PluginListItem> {
  const resolved = resolveScope(scope);
  const now = new Date().toISOString();
  const id = randomUUID();

  const existing = await getPluginByName(conn, input.name, scope);
  if (existing) {
    throw new PluginError('conflict', `Plugin ${input.name} already installed in this workspace.`);
  }

  const row = {
    id,
    workspaceId: resolved.workspaceId,
    name: input.name,
    version: input.version,
    manifest: JSON.stringify(input.manifest),
    enabled: false,
    installedFrom: input.installedFrom ?? null,
    installedByUser: input.installedByUser ?? resolved.userId,
    pluginSettings: input.settings ? JSON.stringify(input.settings) : null,
    createdAt: now,
    updatedAt: now,
  };

  if (conn.dialect === 'sqlite') {
    await conn.db.insert(conn.schema.plugins).values({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      version: row.version,
      manifest: row.manifest,
      enabled: false,
      installedFrom: row.installedFrom,
      installedByUser: row.installedByUser,
      pluginSettings: input.settings ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } else {
    await conn.db.insert(conn.schema.plugins).values({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      version: row.version,
      manifest: row.manifest,
      enabled: false,
      installedFrom: row.installedFrom,
      installedByUser: row.installedByUser,
      pluginSettings: row.pluginSettings,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  return {
    id,
    workspaceId: resolved.workspaceId,
    name: input.name,
    version: input.version,
    manifest: input.manifest,
    enabled: false,
    installedFrom: row.installedFrom,
    installedByUser: row.installedByUser,
    settings: input.settings ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updatePluginEnabled(
  conn: Conn,
  name: string,
  enabled: boolean,
  scope?: WorkspaceScope
): Promise<PluginListItem> {
  const existing = await getPluginByName(conn, name, scope);
  if (!existing) throw new PluginError('not_found', `Plugin ${name} not found.`);
  const resolved = resolveScope(scope);
  const now = new Date().toISOString();

  if (conn.dialect === 'sqlite') {
    const t = conn.schema.plugins;
    await conn.db
      .update(t)
      .set({ enabled: enabled as unknown as boolean, updatedAt: now })
      .where(and(eq(t.workspaceId, resolved.workspaceId), eq(t.name, name.trim())));
  } else {
    const t = conn.schema.plugins;
    await conn.db
      .update(t)
      .set({ enabled, updatedAt: now })
      .where(and(eq(t.workspaceId, resolved.workspaceId), eq(t.name, name.trim())));
  }

  return { ...existing, enabled, updatedAt: now };
}

export async function updatePluginSettings(
  conn: Conn,
  name: string,
  settings: Record<string, unknown>,
  scope?: WorkspaceScope
): Promise<PluginListItem> {
  const existing = await getPluginByName(conn, name, scope);
  if (!existing) throw new PluginError('not_found', `Plugin ${name} not found.`);
  const resolved = resolveScope(scope);
  const now = new Date().toISOString();

  if (conn.dialect === 'sqlite') {
    const t = conn.schema.plugins;
    await conn.db
      .update(t)
      .set({ pluginSettings: settings as unknown as string, updatedAt: now })
      .where(and(eq(t.workspaceId, resolved.workspaceId), eq(t.name, name.trim())));
  } else {
    const t = conn.schema.plugins;
    await conn.db
      .update(t)
      .set({ pluginSettings: JSON.stringify(settings), updatedAt: now })
      .where(and(eq(t.workspaceId, resolved.workspaceId), eq(t.name, name.trim())));
  }

  return { ...existing, settings, updatedAt: now };
}

// v3.0 Phase 6 — marketplace install-over: replace the recorded version and
// manifest, keep the enabled state and settings untouched.
export async function updatePluginVersion(
  conn: Conn,
  name: string,
  input: { version: string; manifest: PluginManifest; installedFrom?: string | null },
  scope?: WorkspaceScope
): Promise<PluginListItem> {
  const existing = await getPluginByName(conn, name, scope);
  if (!existing) throw new PluginError('not_found', `Plugin ${name} not found.`);
  const resolved = resolveScope(scope);
  const now = new Date().toISOString();
  const manifestJson = JSON.stringify(input.manifest);

  if (conn.dialect === 'sqlite') {
    const t = conn.schema.plugins;
    await conn.db
      .update(t)
      .set({
        version: input.version,
        manifest: manifestJson,
        installedFrom: input.installedFrom ?? existing.installedFrom,
        updatedAt: now,
      })
      .where(and(eq(t.workspaceId, resolved.workspaceId), eq(t.name, name.trim())));
  } else {
    const t = conn.schema.plugins;
    await conn.db
      .update(t)
      .set({
        version: input.version,
        manifest: manifestJson,
        installedFrom: input.installedFrom ?? existing.installedFrom,
        updatedAt: now,
      })
      .where(and(eq(t.workspaceId, resolved.workspaceId), eq(t.name, name.trim())));
  }

  return {
    ...existing,
    version: input.version,
    manifest: input.manifest,
    installedFrom: input.installedFrom ?? existing.installedFrom,
    updatedAt: now,
  };
}

export async function deletePlugin(conn: Conn, name: string, scope?: WorkspaceScope): Promise<void> {
  const existing = await getPluginByName(conn, name, scope);
  if (!existing) throw new PluginError('not_found', `Plugin ${name} not found.`);
  const resolved = resolveScope(scope);
  if (conn.dialect === 'sqlite') {
    const t = conn.schema.plugins;
    await conn.db.delete(t).where(and(eq(t.workspaceId, resolved.workspaceId), eq(t.name, name.trim())));
  } else {
    const t = conn.schema.plugins;
    await conn.db.delete(t).where(and(eq(t.workspaceId, resolved.workspaceId), eq(t.name, name.trim())));
  }
}
