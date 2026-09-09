// GET/POST /api/events — the v2.0 Phase 6 event matcher API. Owner-only
// (proxy boundary).
//
//   GET  ?query=&upcoming=&limit=&offset=          events + network overlap counts
//   POST { name, location?, startsAt?, endsAt? }   add one event by hand
//   POST multipart/form-data (field `file`)        import a CSV of events
//   POST { csv }                                   same, as JSON (?dryRun=1 to preview)
//
// Imports are idempotent and always explain themselves: the response says how
// many attendee lines matched, how many need review, how many were ambiguous
// (never linked), and that the co-attendee edges it wrote are *pending*.
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import { importEvents, listEvents, upsertEvent } from "@netpro/core/src/events";
import { crmErrorResponse, crmJson, readCrmJson } from "@/lib/crm-request";
import {
  boundedName,
  dryRunFlag,
  eventListParams,
  readEventCsv,
} from "@/lib/events-request";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const sp = new URL(request.url).searchParams;
  try {
    const scope = await requireScope();
    const { query, upcoming, limit, offset } = eventListParams(sp);
    const { events, total } = await listEvents(conn, {
      query,
      upcoming,
      limit,
      offset,
      scope,
    });
    return crmJson({ events, total, limit, offset });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const sp = new URL(request.url).searchParams;
  try {
    const type = request.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (type === "multipart/form-data") {
      const scope = await requireScope("member");
      const csv = await readEventCsv(request);
      const summary = await importEvents(conn, {
        csv,
        dryRun: dryRunFlag(sp.get("dryRun")),
        includeReview: dryRunFlag(sp.get("review")),
        edges: sp.get("edges") !== "false",
        scope,
      });
      return crmJson(summary, 201);
    }

    const scope = await requireScope("member");
    const body = await readCrmJson(request);
    if (typeof body.csv === "string") {
      const summary = await importEvents(conn, {
        csv: body.csv,
        dryRun: dryRunFlag(body.dryRun ?? sp.get("dryRun")),
        includeReview: dryRunFlag(body.review ?? sp.get("review")),
        edges: body.edges === undefined ? true : body.edges !== false,
        scope,
      });
      return crmJson(summary, 201);
    }

    const result = await upsertEvent(
      conn,
      {
        name: boundedName(body.name, "name") ?? "",
        location: boundedName(body.location, "location"),
        startsAt: boundedName(body.startsAt, "startsAt"),
        endsAt: boundedName(body.endsAt, "endsAt"),
        source: "manual",
      },
      { scope },
    );
    return crmJson(result, 201);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
