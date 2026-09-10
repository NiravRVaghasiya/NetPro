/* eslint-disable @typescript-eslint/no-explicit-any */
import { conn } from '@/lib/db';
import { requireMembership } from '@/lib/authz';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { getPluginByName, deletePlugin } from '@netpro/core/src/plugins/repository';
import { writeActivityLog } from '@netpro/core/src/crm/activity';

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  try {
    const scope = await requireMembership('admin');
    const { name } = await params;
    const plugin = await getPluginByName(conn, name, scope);
    if (!plugin) return crmJson({ error: 'Plugin not found' }, 404);
    return crmJson(plugin);
  } catch (error: unknown) {
    if ((error as any)?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if ((error as any)?.status === 403) return crmJson({ error: (error as Error).message }, 403);
    return crmErrorResponse(error);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  try {
    const scope = await requireMembership('admin');
    const { name: delName } = await params;
    await deletePlugin(conn, delName, scope);
    await writeActivityLog(
      conn,
      {
        action: 'plugin.removed',
        entityType: 'plugin',
        entityId: delName,
        metadata: { workspaceId: scope.workspaceId },
      },
      scope
    );
    return crmJson({ ok: true });
  } catch (error: unknown) {
    if ((error as any)?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if ((error as any)?.status === 403) return crmJson({ error: (error as Error).message }, 403);
    return crmErrorResponse(error);
  }
}
