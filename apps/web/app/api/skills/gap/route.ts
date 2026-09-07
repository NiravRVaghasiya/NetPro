import { conn } from '@/lib/db';
import { analyzeNetworkGaps, loadSkillContacts } from '@netpro/core/src/skills';
import { crmErrorResponse, crmJson } from '@/lib/crm-request';

/** Owner-only skills gap analysis. Extraction is offline and bounded by the shared taxonomy. */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const role = params.get('role')?.trim() ?? '';
  const description = params.get('description')?.trim() ?? '';
  if (!role && !description) return new Response(JSON.stringify({ error: 'role or description is required' }), { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    const contacts = await loadSkillContacts(conn);
    return crmJson(analyzeNetworkGaps({ role, description }, contacts));
  } catch (error) {
    return crmErrorResponse(error);
  }
}
