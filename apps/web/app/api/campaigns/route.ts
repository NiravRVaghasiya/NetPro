import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import {
  createCampaign,
  listCampaigns,
  CAMPAIGN_STATUSES,
} from "@netpro/core/src/campaigns";
import {
  CrmRequestError,
  crmErrorResponse,
  crmJson,
  paginationParams,
  readCrmJson,
} from "@/lib/crm-request";

/**
 * GET /api/campaigns?status=draft|active|paused|completed|archived&limit=&offset=
 * Campaign list (most recently updated first) plus the total count for paging.
 */
export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  try {
    const { limit, offset } = paginationParams(p);
    const statusParam = p.get("status")?.trim() || undefined;
    if (statusParam && !CAMPAIGN_STATUSES.includes(statusParam as never)) {
      throw new CrmRequestError(
        400,
        `Unknown status "${statusParam}". Expected one of: ${CAMPAIGN_STATUSES.join(", ")}.`,
      );
    }
    const scope = await requireScope();
    const page = await listCampaigns(
      conn,
      { status: statusParam, limit, offset },
      scope,
    );
    return crmJson(page);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

/**
 * POST /api/campaigns
 * Create a draft campaign. Body:
 *   { name, description?, template: { subject, body }, steps?,
 *     dailyLimit?, sendFrom?, recipients?: { contactIds? | search? } }
 * Recipients are snapshotted at create time (never a live query afterwards).
 * Returns 201 with { campaign, added, skippedDuplicates }.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const scope = await requireScope("member");
    const body = await readCrmJson(request);
    const recipients = body.recipients;
    const result = await createCampaign(
      conn,
      {
        name: String(body.name ?? ""),
        description:
          (body.description as string | null | undefined) ?? undefined,
        sendFrom: (body.sendFrom as string | null | undefined) ?? undefined,
        dailyLimit: toOptionalNumber(body.dailyLimit),
        template: body.template,
        steps: body.steps,
        recipients:
          recipients &&
          typeof recipients === "object" &&
          !Array.isArray(recipients)
            ? (recipients as {
                contactIds?: string[];
                search?: Record<string, unknown>;
              })
            : undefined,
      },
      {},
      scope,
    );
    return crmJson(result, 201);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}
