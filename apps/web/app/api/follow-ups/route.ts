import { conn } from '@/lib/db';
import { requireScope } from '@/lib/authz';
import {
  createFollowUp,
  listFollowUps,
  type FollowUpView,
} from '@netpro/core/src/crm';
import {
  CrmRequestError,
  crmErrorResponse,
  crmJson,
  paginationParams,
  readCrmJson,
} from '@/lib/crm-request';

const VIEWS: FollowUpView[] = [
  'pending',
  'overdue',
  'due-today',
  'upcoming',
  'completed',
  'cancelled',
  'all',
];

/**
 * GET /api/follow-ups?view=pending|overdue|due-today|upcoming|completed|cancelled|all
 *                   &contactId=&limit=
 * Follow-up list plus the pending counts (overdue/dueToday/upcoming) every
 * surface renders.
 */
export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  try {
    const { limit } = paginationParams(p);
    const viewParam = p.get('view') ?? 'pending';
    if (!VIEWS.includes(viewParam as FollowUpView)) {
      throw new CrmRequestError(400, `Unknown view "${viewParam}". Expected one of: ${VIEWS.join(', ')}.`);
    }
    const scope = await requireScope();
    const assignedToParam = p.get('assignedTo')?.trim() || undefined;
    const assignedToMe = p.get('assignedToMe') === '1' || p.get('assignedToMe') === 'true';
    const unassigned = p.get('unassigned') === '1' || p.get('unassigned') === 'true';
    const summary = await listFollowUps(
      conn,
      {
        view: viewParam as FollowUpView,
        contactId: p.get('contactId')?.trim() || undefined,
        limit,
        assignedTo: assignedToParam ?? undefined,
        assignedToMe: assignedToMe ? scope.userId : undefined,
        unassigned: unassigned ? true : undefined,
      },
      scope,
    );
    return crmJson(summary);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

/**
 * POST /api/follow-ups
 * Schedule a follow-up. Body: { contactId, dueAt? | dueInMs?, reason?,
 * recurrenceRule? } — `dueAt` is an ISO date, `dueInMs` a positive relative
 * window; a `recurrenceRule` like "30d" makes it re-arm on completion.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const scope = await requireScope();
    const body = await readCrmJson(request);
    const dueInMs = body.dueInMs;
    const followUp = await createFollowUp(
      conn,
      {
        contactId: String(body.contactId ?? ''),
        dueAt: (body.dueAt as string | undefined) ?? undefined,
        dueInMs:
          typeof dueInMs === 'number' && Number.isFinite(dueInMs)
            ? dueInMs
            : dueInMs === undefined || dueInMs === null
              ? undefined
              : Number(dueInMs),
        reason: (body.reason as string | undefined) ?? undefined,
        recurrenceRule: (body.recurrenceRule as string | undefined) ?? undefined,
        assignedTo: (body.assignedTo as string | undefined) ?? undefined,
      },
      {},
      scope,
    );
    return crmJson(followUp, 201);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
