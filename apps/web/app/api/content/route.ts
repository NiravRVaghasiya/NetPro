// GET/POST /api/content — the v2.5 Phase 5 content tracker API. Owner-only
// (proxy boundary).
//
//   GET  ?platform=&tag=&days=&query=&limit=&offset=   items, newest-published first
//   POST { url, title, platform?, type?, author?, tags?, publishedAt? }
//                                                   add one piece (idempotent on URL)
//   POST { csv } | { feedXml } (?dryRun=1)          import; per-row errors reported
//   POST multipart/form-data (field `file`)         same, for a CSV/feed-XML upload
//
// Imports are idempotent and self-explaining: every row that did not write
// is a reported error or warning, never a silent drop, and a duplicate URL
// returns the existing row untouched (`created: false`).
import { requireScope } from "@/lib/authz";
import { conn } from "@/lib/db";
import {
  importContent,
  listContentSummaries,
  upsertContentItem,
} from "@netpro/core/src/content";
import {
  CrmRequestError,
  crmErrorResponse,
  crmJson,
  readCrmJson,
} from "@/lib/crm-request";
import {
  contentListParams,
  dryRunFlag,
  readContentFile,
} from "@/lib/content-request";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const sp = new URL(request.url).searchParams;
  try {
    const scope = await requireScope();
    const params = { ...contentListParams(sp), scope };
    const { items, total, limit, offset } = await listContentSummaries(
      conn,
      params,
    );
    return crmJson({ items, total, limit, offset });
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
    const scope = await requireScope("member");
    if (type === "multipart/form-data") {
      const text = await readContentFile(request);
      const looksLikeXml = text.trimStart().startsWith("<");
      const summary = await importContent(conn, {
        csv: looksLikeXml ? undefined : text,
        feedXml: looksLikeXml ? text : undefined,
        dryRun: dryRunFlag(sp.get("dryRun")),
        scope,
      });
      return crmJson(summary, 201);
    }

    const body = await readCrmJson(request);
    const csv = typeof body.csv === "string" ? body.csv : undefined;
    const feedXml = typeof body.feedXml === "string" ? body.feedXml : undefined;
    if (csv !== undefined || feedXml !== undefined) {
      if (csv !== undefined && feedXml !== undefined) {
        throw new CrmRequestError(
          400,
          'Send exactly one of "csv" or "feedXml".',
        );
      }
      const summary = await importContent(conn, {
        csv,
        feedXml,
        dryRun: dryRunFlag(body.dryRun ?? sp.get("dryRun")),
        scope,
      });
      return crmJson(summary, 201);
    }

    const tags = Array.isArray(body.tags)
      ? (body.tags as unknown[]).filter(
          (t): t is string => typeof t === "string",
        )
      : typeof body.tags === "string"
        ? body.tags
        : undefined;
    const { item, created } = await upsertContentItem(
      conn,
      {
        url: typeof body.url === "string" ? body.url : "",
        title: typeof body.title === "string" ? body.title : "",
        platform: typeof body.platform === "string" ? body.platform : undefined,
        type: typeof body.type === "string" ? body.type : undefined,
        author: typeof body.author === "string" ? body.author : undefined,
        tags,
        publishedAt:
          typeof body.publishedAt === "string" ? body.publishedAt : undefined,
        source: "manual",
      },
      { scope },
    );
    return crmJson({ item, created }, 201);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
