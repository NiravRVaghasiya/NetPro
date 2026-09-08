// GET/POST /api/content/[id]/metrics
//
//   GET  ?days=&limit=            the snapshot series, oldest first
//   POST { views?, likes?, comments?, shares?, bookmarks?, fetchedAt?, source? }
//                                append one snapshot (≥1 metric, never an update)
//
// Snapshots are append-only: the owner's numbers land as a new row, and the
// latest snapshot is the one the totals are read from — so a correction is a
// new snapshot with the right numbers, and history stays honest.
import { conn } from "@/lib/db";
import {
  getContentMetricsSeries,
  recordMetrics,
} from "@netpro/core/src/content";
import {
  CrmRequestError,
  crmErrorResponse,
  crmJson,
  readCrmJson,
} from "@/lib/crm-request";
import { metricCount, resolveOptionalContent } from "@/lib/content-request";

export const runtime = "nodejs";

function boundedInt(
  raw: string | null,
  def: number,
  min: number,
  max: number,
): number {
  if (raw === null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const sp = new URL(request.url).searchParams;
  try {
    const { id } = await context.params;
    const content = await resolveOptionalContent(conn, id);
    if (!content)
      throw new CrmRequestError(404, "A content id or URL is required.");
    const days = sp.get("days");
    const series = await getContentMetricsSeries(conn, content.id, {
      days: days === null ? undefined : boundedInt(days, 90, 1, 365),
      limit: boundedInt(sp.get("limit"), 365, 1, 365),
    });
    return crmJson(series);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const content = await resolveOptionalContent(conn, id);
    if (!content)
      throw new CrmRequestError(404, "A content id or URL is required.");
    const body = await readCrmJson(request);
    const metric = await recordMetrics(conn, {
      contentId: content.id,
      views: metricCount(body.views, "views"),
      likes: metricCount(body.likes, "likes"),
      comments: metricCount(body.comments, "comments"),
      shares: metricCount(body.shares, "shares"),
      bookmarks: metricCount(body.bookmarks, "bookmarks"),
      fetchedAt:
        typeof body.fetchedAt === "string" ? body.fetchedAt : undefined,
      source: typeof body.source === "string" ? body.source : "manual",
    });
    return crmJson({ metric }, 201);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
