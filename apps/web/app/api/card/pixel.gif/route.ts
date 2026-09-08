// GET /api/card/pixel.gif — v2.5 Phase 2: the public tracking pixel.
//
// A 1×1 transparent GIF for the owner's card and blog/portfolio embeds:
// no auth, no cookies, no third parties, never sets `Set-Cookie`. All
// hardening (salted hashing, bot labeling, dedup, DNT minimal mode, 60/min
// per-IP rate limit) happens before — or instead of — the single small
// `profile_views` row. The response is ALWAYS the GIF (200, or 429 when
// rate-limited): a broken or disabled beacon must never break the visitor's
// page, and the status must not leak owner-side state.
import { conn } from "@/lib/db";
import {
  beaconRateLimiter,
  readViewBeaconContext,
  viewsDisabled,
} from "@/lib/beacon";
import { recordView } from "@netpro/core/src/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The canonical 1×1 transparent GIF (42 bytes).
const TRANSPARENT_PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function pixelResponse(status = 200): Response {
  return new Response(TRANSPARENT_PIXEL_GIF, {
    status,
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, private",
      // The pixel is meant to be embedded on the owner's own blog.
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  if (viewsDisabled()) return pixelResponse(); // GIF yes, write no.
  const url = new URL(request.url);
  let context;
  try {
    context = await readViewBeaconContext(request, {
      page: url.searchParams.get("p"),
      referrer: url.searchParams.get("r"),
      viewToken: url.searchParams.get("v"),
    });
  } catch {
    // A malformed request is nobody's fault here — still serve the pixel.
    return pixelResponse();
  }
  if (!beaconRateLimiter.allow(context.rateLimitKey)) return pixelResponse(429);
  try {
    await recordView(conn, context.record);
  } catch {
    // Database trouble never 500s the pixel; the page keeps rendering.
  }
  return pixelResponse();
}
