// apps/web/lib/beacon.ts — v2.5 Phase 2: shared ingestion context for the
// public profile-view beacons (`GET /api/card/pixel.gif`, `POST /api/card/view`).
//
// Both endpoints are public by design (no auth, no cookies, no third
// parties). This module is the only place that reads request headers for
// the beacons, so the privacy rules live in one testable seam:
//
//   * IP comes from the FIRST `X-Forwarded-For` entry or `X-Real-Ip`,
//     validated as an IP literal; it is used ONLY as the rate-limit key and
//     the HMAC input — it is never stored or logged raw.
//   * `DNT: 1` / `Sec-GPC: 1` → minimal mode: the view is still counted
//     (respect, not refuse), but geo, UA, referrer, UTM, duration and the
//     resolution token are dropped.
//   * A signed `?v=` token (owner-minted, HMAC under NEXTAUTH_SECRET,
//     30-day cap) may name a known contact; a missing or dead contact
//     resolves to `null` rather than an error.
//   * An authenticated session means the owner (this app is single-owner;
//     Auth.js rejects anyone else on every JWT read) → `is_owner_view`.
import { auth } from "@/lib/auth";
import { conn } from "@/lib/db";
import {
  BEACON_RATE_LIMIT,
  createRateLimiter,
  extractViewerGeo,
  extractViewerIp,
  findLiveContactId,
  hashViewerIp,
  isDntRequest,
  mergeUtm,
  parseReferrer,
  parseUtm,
  resolveContactFromToken,
  type RecordViewInput,
} from "@netpro/core/src/views";

// One in-memory bucket per server process (plan: "in-memory token bucket,
// no Redis"). Multi-instance serverless deploys apply the limit per
// instance — documented, bounded, and combined with per-request hardening.
export const beaconRateLimiter = createRateLimiter(BEACON_RATE_LIMIT);

/** `NETPRO_DISABLE_VIEWS=true` → endpoints answer, but nothing is written. */
export function viewsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NETPRO_DISABLE_VIEWS ?? "").trim().toLowerCase() === "true";
}

/**
 * Base salt for the daily viewer hashes: the operator's `NETPRO_VIEW_SALT`,
 * falling back to `NEXTAUTH_SECRET` (required for auth anyway) so even an
 * unconfigured instance gets a per-deployment salt.
 */
export function viewBaseSalt(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.NETPRO_VIEW_SALT?.trim() ||
    env.NEXTAUTH_SECRET?.trim() ||
    "netpro-default-view-salt"
  );
}

export interface ViewBeaconInput {
  /** Page requested via `?p=` (pixel) or the JSON body. */
  page?: string | null;
  /** Explicit referrer via `?r=` (pixel) or the JSON body. */
  referrer?: string | null;
  durationMs?: number | null;
  /** Signed `?v=` contact-resolution token (pixel only). */
  viewToken?: string | null;
}

export interface ViewBeaconContext {
  /** Ready for `recordView`. */
  record: RecordViewInput;
  /** Rate-limit key: the daily-salted IP hash — never the raw IP. */
  rateLimitKey: string;
}

export async function readViewBeaconContext(
  request: Request,
  input: ViewBeaconInput,
): Promise<ViewBeaconContext> {
  const headers = request.headers;
  const ip = extractViewerIp(headers);
  const dnt = isDntRequest(headers);
  const geo = extractViewerGeo(headers);

  // Explicit beacon params beat the referrer's own query string, per field.
  const rawReferrer = input.referrer ?? headers.get("referer");
  const utm = mergeUtm(parseUtm(new URL(request.url).searchParams), parseUtm(rawReferrer));

  // A valid session is the owner's session; there is no other kind.
  const session = await auth();

  let resolvedContact: string | null = null;
  if (input.viewToken) {
    const candidate = resolveContactFromToken(input.viewToken, {
      secret: process.env.NEXTAUTH_SECRET ?? "",
    });
    if (candidate) resolvedContact = await findLiveContactId(conn, candidate);
  }

  const now = new Date();
  const baseSalt = viewBaseSalt();
  return {
    record: {
      viewedPage: input.page ?? "/card",
      ip,
      userAgent: headers.get("user-agent"),
      acceptLanguage: headers.get("accept-language"),
      referrer: dnt ? null : parseReferrer(rawReferrer),
      utmSource: dnt ? null : utm.source,
      utmMedium: dnt ? null : utm.medium,
      utmCampaign: dnt ? null : utm.campaign,
      country: dnt ? null : geo.country,
      city: dnt ? null : geo.city,
      durationMs: input.durationMs ?? null,
      resolvedContact: dnt ? null : resolvedContact,
      authenticatedOwnerSession: Boolean(session?.user?.id),
      minimalPrivacy: dnt,
      baseSalt,
      now,
    },
    rateLimitKey: ip
      ? hashViewerIp({
          ip,
          userAgent: headers.get("user-agent"),
          baseSalt,
          date: now,
        })
      : "no-ip",
  };
}
