import { conn } from '@/lib/db';
import {
  countInteractions,
  listInteractions,
  logInteraction,
} from '@netpro/core/src/crm';
import {
  crmErrorResponse,
  crmJson,
  paginationParams,
  readCrmJson,
} from '@/lib/crm-request';

/**
 * GET /api/interactions?contactId=&limit=&offset=
 * Interaction history — per contact, or the global recent feed.
 */
export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  try {
    const { limit, offset } = paginationParams(p);
    const contactId = p.get('contactId')?.trim() || undefined;
    const [interactions, total] = await Promise.all([
      listInteractions(conn, { contactId, limit, offset }),
      countInteractions(conn, contactId),
    ]);
    return crmJson({ interactions, total, limit, offset });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

/**
 * POST /api/interactions
 * Log an interaction. Body: { contactId, type, direction?, subject?,
 * content?, channel?, occurredAt? }. The core module whitelists the
 * vocabularies, bounds the lengths and timestamps, and recomputes the
 * contact's stats + relationship score in the same call.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readCrmJson(request);
    const result = await logInteraction(conn, {
      contactId: String(body.contactId ?? ''),
      type: String(body.type ?? ''),
      direction: (body.direction as string | null | undefined) ?? undefined,
      subject: (body.subject as string | null | undefined) ?? undefined,
      content: (body.content as string | null | undefined) ?? undefined,
      channel: (body.channel as string | null | undefined) ?? undefined,
      occurredAt: (body.occurredAt as string | null | undefined) ?? undefined,
    });
    return crmJson(
      { interaction: result.interaction, stats: result.stats, contact: result.contact },
      201
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
