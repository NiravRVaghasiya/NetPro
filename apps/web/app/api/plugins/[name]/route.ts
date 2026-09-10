/* eslint-disable @typescript-eslint/no-explicit-any */
import { conn } from '@/lib/db';
import { requireMembership } from '@/lib/authz';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { pluginErrorResponse } from '@/lib/plugins';
import { getPluginByName } from '@netpro/core/src/plugins/repository';
import { uninstallPlugin } from '@netpro/core/src/plugins/marketplace';

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
    // v3.0 Phase 6 — rm unregisters AND deletes the files (audited inside).
    const result = await uninstallPlugin(conn, delName, { scope });
    return crmJson({ ok: true, filesRemoved: result.filesRemoved });
  } catch (error: unknown) {
    return pluginErrorResponse(error);
  }
}
