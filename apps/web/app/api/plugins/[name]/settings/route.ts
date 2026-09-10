/* eslint-disable @typescript-eslint/no-explicit-any */
import { conn } from '@/lib/db';
import { requireMembership } from '@/lib/authz';
import { crmJson, crmErrorResponse } from '@/lib/crm-request';
import { updatePluginSettings } from '@netpro/core/src/plugins/repository';

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  try {
    const scope = await requireMembership('admin');
    const body = await request.json().catch(() => ({}));
    const settings = body.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return crmJson({ error: 'settings object required' }, 400);
    }
    const { name } = await params;
    const updated = await updatePluginSettings(conn, name, settings as Record<string, unknown>, scope);
    return crmJson(updated);
  } catch (error: unknown) {
    if ((error as any)?.status === 401) return crmJson({ error: 'Unauthorized' }, 401);
    if ((error as any)?.status === 403) return crmJson({ error: (error as Error).message }, 403);
    return crmErrorResponse(error);
  }
}
