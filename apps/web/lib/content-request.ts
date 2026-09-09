// apps/web/lib/content-request.ts
//
// Shared parsing for the v2.5 Phase 5 content routes. The proxy is the
// ownership boundary (all /api/* require the owner session); these helpers
// cover what the boundary does not: bounded list parameters, a bounded CSV
// upload, and content/contact selectors that answer the house way — unknown
// → 404 via the shared resolver (a normalized URL never collides, so
// ambiguity is impossible for content). Validation of item fields and
// metrics (platform whitelist, dates, tag caps, non-negative integers)
// lives in the core, which raises ContentError; this file only shapes the
// request before handing it over.
import type { SqliteConn, PgConn } from "@netpro/db";
import { resolveContactRef, type ContactRef } from "@netpro/core/src/ai";
import { resolveContentRef, type ContentItem } from "@netpro/core/src/content";
import type { WorkspaceScope } from "@netpro/core/src/workspaces/scope";
import { CrmRequestError } from "./crm-request";

/** 1 MiB is ~10k content rows — generous for a spreadsheet export. */
export const MAX_CONTENT_CSV_BYTES = 1024 * 1024;

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

function boundedText(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new CrmRequestError(400, `${field} must be a string.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length > max) {
    throw new CrmRequestError(
      400,
      `${field} must be ${max} characters or fewer.`,
    );
  }
  return trimmed === "" ? null : trimmed;
}

/**
 * `?platform=&tag=&days=&query=&limit=&offset=` for `GET /api/content`.
 * Garbage falls back, out-of-range clamps, unknown platforms reach the core
 * (a 400 with the whitelist named, never a silent widening).
 */
export function contentListParams(sp: URLSearchParams): {
  platform?: string;
  tag?: string;
  days?: number;
  query?: string;
  limit: number;
  offset: number;
} {
  const rawDays = sp.get("days");
  return {
    platform: boundedText(sp.get("platform"), "platform", 40) ?? undefined,
    tag: boundedText(sp.get("tag"), "tag", 200) ?? undefined,
    // No window by default — the library, not the last N days, is the
    // listing; the caller opts in (page select offers 7/30/90/all).
    days: rawDays === null ? undefined : boundedInt(rawDays, 90, 1, 365),
    query: boundedText(sp.get("query"), "query", 200) ?? undefined,
    limit: boundedInt(sp.get("limit"), 50, 1, 100),
    offset: boundedInt(sp.get("offset"), 0, 0, 100_000),
  };
}

/**
 * Resolve an optional content selector (id or exact URL, tracking junk
 * tolerated). Unknown → 404; the selector itself is bounded.
 */
export async function resolveOptionalContent(
  conn: SqliteConn | PgConn,
  selector: string | null | undefined,
  scope?: WorkspaceScope,
): Promise<ContentItem | null> {
  const trimmed = selector?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 4096)
    throw new CrmRequestError(400, "content selector is too long.");
  try {
    return await resolveContentRef(conn, trimmed, scope);
  } catch {
    throw new CrmRequestError(
      404,
      `No content found with id or URL "${trimmed.slice(0, 120)}".`,
    );
  }
}

/** Same contract for the contact half of a mention. */
export async function resolveOptionalContact(
  conn: SqliteConn | PgConn,
  selector: string | null | undefined,
  scope?: WorkspaceScope,
): Promise<ContactRef | null> {
  const trimmed = selector?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 320)
    throw new CrmRequestError(400, "contact selector is too long.");
  try {
    return await resolveContactRef(conn, trimmed, scope);
  } catch (e) {
    const message = (e as Error).message;
    if (message.startsWith("Ambiguous"))
      throw new CrmRequestError(400, message);
    throw new CrmRequestError(404, message);
  }
}

/**
 * Read a bounded upload (`multipart/form-data`, field `file`): a CSV of
 * content rows or an RSS/Atom XML file. The caller decides which by content.
 */
export async function readContentFile(request: Request): Promise<string> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new CrmRequestError(
      400,
      'Expected a multipart/form-data upload with a "file" field.',
    );
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new CrmRequestError(400, "A CSV or feed XML file is required.");
  }
  if (file.size > MAX_CONTENT_CSV_BYTES) {
    throw new CrmRequestError(
      413,
      `File must be ${MAX_CONTENT_CSV_BYTES / 1024} KiB or smaller.`,
    );
  }
  return file.text();
}

/** `?dryRun=1` / `{ "dryRun": true }` — previews write nothing. */
export function dryRunFlag(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw === "string")
    return raw === "1" || raw.toLowerCase() === "true";
  return false;
}

/** A metric count from JSON: a non-negative integer or null, else 400. */
export function metricCount(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > 2_147_483_647
  ) {
    throw new CrmRequestError(400, `${field} must be a non-negative integer.`);
  }
  return raw;
}
