// POST /api/card/view — v2.5 Phase 2: the JSON companion beacon.
//
// For JS-enabled surfaces (`navigator.sendBeacon` on pagehide of /card, or
// an owner's embed) to report a read duration: `{ page?, referrer?,
// durationMs? }`. Same hardening as the pixel, plus JSON-specific rules:
// 415 for a wrong content type, 400 for oversized/malformed bodies, CORS
// `*` (with an OPTIONS preflight handler) because embeds are cross-origin.
// The response is `{ counted, reason }` for the owner's own debugging —
// it carries no owner-side state (reasons are request-local).
import { conn } from "@/lib/db";
import {
  beaconRateLimiter,
  readViewBeaconContext,
  viewsDisabled,
} from "@/lib/beacon";
import { VIEW_DURATION_MAX_MS, recordView } from "@netpro/core/src/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The beacon payload is three small strings/numbers — 8 KiB is generous. */
const VIEW_BODY_MAX_BYTES = 8 * 1024;

function corsHeaders(): Record<string, string> {
  return { "Access-Control-Allow-Origin": "*", Vary: "Origin" };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", ...corsHeaders() },
  });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "private, no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      Vary: "Origin",
    },
  });
}

type BodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; message: string };

async function readBeaconBody(request: Request): Promise<BodyResult> {
  const type = request.headers
    .get("content-type")
    ?.split(";")[0]?.trim()
    .toLowerCase();
  if (type !== "application/json") {
    return { ok: false, status: 415, message: "Content-Type must be application/json." };
  }
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > VIEW_BODY_MAX_BYTES)
  ) {
    return { ok: false, status: 400, message: "Request body is too large." };
  }
  if (!request.body) {
    return { ok: false, status: 400, message: "A JSON object is required." };
  }
  // Bound the stream itself, not only the (spoofable) Content-Length.
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > VIEW_BODY_MAX_BYTES) {
        await reader.cancel();
        return { ok: false, status: 400, message: "Request body is too large." };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    return { ok: false, status: 400, message: "Body must be a JSON object." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, message: "Body must be a JSON object." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export async function POST(request: Request): Promise<Response> {
  if (viewsDisabled()) return json({ counted: false, reason: "disabled" });

  const body = await readBeaconBody(request);
  if (!body.ok) return json({ error: body.message }, body.status);

  const { page, referrer, durationMs, viewToken } = body.value;
  if (page !== undefined && typeof page !== "string") {
    return json({ error: "page must be a string." }, 400);
  }
  if (referrer !== undefined && typeof referrer !== "string") {
    return json({ error: "referrer must be a string." }, 400);
  }
  if (
    durationMs !== undefined &&
    (typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      durationMs > VIEW_DURATION_MAX_MS)
  ) {
    return json({ error: "durationMs must be a number of 0–3600000." }, 400);
  }
  // The /card?v= token rides along in JS beacons too (the page's pixel only
  // loads without JS), so tokenized links resolve with or without a browser.
  if (viewToken !== undefined && (typeof viewToken !== "string" || viewToken.length > 512)) {
    return json({ error: "viewToken must be a string of 512 chars or fewer." }, 400);
  }

  let context;
  try {
    context = await readViewBeaconContext(request, {
      page,
      referrer,
      durationMs,
      viewToken,
    });
  } catch {
    return json({ error: "Unable to read the request." }, 400);
  }
  if (!beaconRateLimiter.allow(context.rateLimitKey)) {
    return json({ error: "Too many requests." }, 429);
  }
  let result;
  try {
    result = await recordView(conn, context.record);
  } catch {
    return json({ error: "Unable to record the view." }, 500);
  }
  return json({ counted: result.counted, reason: result.reason });
}
