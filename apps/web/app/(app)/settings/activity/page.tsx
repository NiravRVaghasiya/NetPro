import { requireScope } from '@/lib/authz';
import { conn } from '@/lib/db';
import { listActivityLog, type ActivityLogRow } from '@netpro/core/src/crm';
import { getWorkspaceMembers } from '@netpro/core/src/workspaces';
import ActivityClient from './client';

export const metadata = {
  title: 'Activity — NetPro',
};

function parsePageParams(searchParams: Record<string, string | string[] | undefined>) {
  const get = (k: string) => {
    const v = searchParams[k];
    return Array.isArray(v) ? v[0] : v;
  };
  return {
    action: get('action')?.trim() || undefined,
    entityType: get('entityType')?.trim() || undefined,
    userId: get('userId')?.trim() || undefined,
    from: get('from')?.trim() || undefined,
    to: get('to')?.trim() || undefined,
    limit: Math.min(Math.max(Number(get('limit') ?? '50'), 1), 100),
    offset: Math.max(Number(get('offset') ?? '0'), 0),
  };
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireScope('admin');
  const params = await searchParams;
  const parsed = parsePageParams(params);

  const [page, members] = await Promise.all([
    listActivityLog(
      conn,
      {
        limit: parsed.limit,
        offset: parsed.offset,
        actionPrefix: parsed.action,
        entityType: parsed.entityType,
        userId: parsed.userId,
        from: parsed.from,
        to: parsed.to,
      },
      ctx
    ),
    getWorkspaceMembers(conn, ctx.workspaceId),
  ]);

  // Resolve user details for member filter
  const userIds = members.map((m) => m.userId);
  let users: Array<{ id: string; name: string | null; email: string }> = [];
  if (userIds.length > 0) {
    const { inArray } = await import('drizzle-orm');
    const rows =
      conn.dialect === 'sqlite'
        ? await conn.db.select().from(conn.schema.users).where(inArray(conn.schema.users.id, userIds))
        : await conn.db.select().from(conn.schema.users).where(inArray(conn.schema.users.id, userIds));
    users = rows as never;
  }

  const membersWithUsers = members.map((m) => ({
    ...m,
    user: users.find((u) => u.id === m.userId) ?? null,
  }));

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold mb-2">Activity log</h1>
      <p className="text-sm text-slate-500 mb-6">
        Audit trail of workspace actions — CRM mutations, invites, role changes, campaign sends. Admin+ only, newest first.
      </p>
      <ActivityClient
        initialPage={page as { rows: ActivityLogRow[]; total: number; limit: number; offset: number }}
        initialFilters={{
          action: parsed.action ?? '',
          entityType: parsed.entityType ?? '',
          userId: parsed.userId ?? '',
          from: parsed.from ?? '',
          to: parsed.to ?? '',
        }}
        members={membersWithUsers}
      />
    </div>
  );
}
