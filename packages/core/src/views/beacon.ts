// v2.5 Phase 2 — the profile-view ingestion pipeline.
//
// This is the producer the scaffold's `profile_views` table waited for.
// `recordView(conn, input)` takes the *already-extracted* request facts
// (headers are read by the web/CLI surfaces, not here) and applies every
// hardening the Phase 1 data model promised:
//
//   * **No raw IP** — `viewer_ip` / `viewer_fingerprint` are daily-salted
//     16-hex HMACs (`privacy.ts`); nothing else touches an IP.
//   * **Bot labeling** — `is_bot` from the vendored deny-list; bots are
//     stored (the owner can debug with an include-bots toggle later) but
//     are excluded from analytics in Phase 3.
//   * **Owner labeling** — `is_owner_view` from an authenticated session
//     or the same-day same-IP heuristic (`owner.ts`); excluded from counts.
//   * **De-duplication** — same fingerprint within 5 minutes, or same
//     IP hash + page within 1 hour, is skipped with a reason instead of a
//     row, so tab-refresh storms and beacon re-sends do not inflate.
//   * **Minimal privacy mode** (DNT/GPC) — the view is still counted (the
//     plan says *respect*, not *refuse*), but only page + time + bot flag
//     are stored: no geo, no UA, no referrer, no UTM, no fingerprint.
//   * **Signed contact resolution** — `?v=` tokens let the owner share a
//     personalized card link; the token is an HMAC under
//     `NEXTAUTH_SECRET` with a 30-day cap, and the referenced contact must
//     still exist. No auto-resolution from IP or email, ever.
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import type { SqliteConn, PgConn } from "@netpro/db";
import { rawAll } from "../search/indexer";
import { classifyUserAgent } from "./bots";
import { shouldMarkOwnerView, recentOwnerViewIpHashes } from "./owner";
import { hashViewerFingerprint, hashViewerIp } from "./privacy";
import { BOOTSTRAP_WORKSPACE_ID } from "../workspaces/scope";

type Conn = SqliteConn | PgConn;

/** Anything with `get(name)` — `Request.headers`, `Headers`, tests. */
export interface BeaconHeaders {
  get(name: string): string | null | undefined;
}

// ── Viewed page allowlist ────────────────────────────────────────────────
//
// The plan caps `viewed_page` to a fixed set; a beacon param like
// `p=../../etc/passwd` normalizes to the default `/card` rather than being
// stored or rejected (beacons should degrade silently, not 400).

export const VIEWED_PAGES = [
  "/card",
  "/card/vcard",
  "blog",
  "portfolio",
  "embed",
] as const;

export type ViewedPage = (typeof VIEWED_PAGES)[number];

/** Snap any requested page onto the allowlist; unknown values → `/card`. */
export function normalizeViewedPage(
  page: string | null | undefined,
): ViewedPage {
  if (typeof page === "string") {
    const trimmed = page.trim();
    for (const allowed of VIEWED_PAGES) {
      if (trimmed === allowed) return allowed;
    }
  }
  return "/card";
}

// ── Request extraction (pure header reading, no I/O) ────────────────────

/**
 * The viewer IP: the FIRST entry of `X-Forwarded-For`, else `X-Real-Ip`,
 * else `null`. The first entry is the claimed client; if it is not a
 * valid IP literal the whole value is treated as absent rather than
 * falling through to proxy hops (a spoofer controls the whole header).
 */
export function extractViewerIp(headers: BeaconHeaders): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first && isIP(first) !== 0) return first;
    return null;
  }
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp && isIP(realIp) !== 0) return realIp;
  return null;
}

const GEO_FIELD_MAX_LENGTH = 64;

/**
 * Geo from platform headers only (Vercel `x-vercel-ip-country/city`,
 * Cloudflare `cf-ipcountry`). NetPro never runs a geo lookup itself —
 * headers are the only source, per the plan.
 */
export function extractViewerGeo(headers: BeaconHeaders): {
  country: string | null;
  city: string | null;
} {
  const country =
    headers.get("x-vercel-ip-country") ?? headers.get("cf-ipcountry") ?? null;
  const city = headers.get("x-vercel-ip-city") ?? null;
  const cap = (value: string | null): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, GEO_FIELD_MAX_LENGTH) : null;
  };
  return { country: cap(country), city: cap(city) };
}

/** Do-Not-Track / Global Privacy Control → minimal storage mode. */
export function isDntRequest(headers: BeaconHeaders): boolean {
  return (
    headers.get("dnt")?.trim() === "1" || headers.get("sec-gpc")?.trim() === "1"
  );
}

// ── De-duplication ───────────────────────────────────────────────────────

/** Rapid-reload window: same fingerprint within 5 min = the same view. */
export const DEDUP_FINGERPRINT_WINDOW_MS = 5 * 60_000;
/** Same IP hash + same page within 1 hour = the same view. */
export const DEDUP_IP_PAGE_WINDOW_MS = 60 * 60_000;

/**
 * Row shape of the dedup probe (snake_case — the raw columns, unmapped).
 * `shouldCountView` consumes exactly what `recordView` selects.
 */
export interface DedupProbeRow {
  [column: string]: unknown;
  viewer_fingerprint: string | null;
  viewer_ip: string | null;
  viewed_page: string;
  /** ISO timestamp as stored, or a Date; either works. */
  viewed_at: string | Date;
}

export interface ShouldCountViewArgs {
  fingerprint: string | null;
  ipHash: string | null;
  viewedPage: string;
  now: Date;
  /** Recent rows already fetched by the caller (see `recordView`). */
  recent: readonly DedupProbeRow[];
  fingerprintWindowMs?: number;
  ipPageWindowMs?: number;
}

export type DedupReason = "new" | "dedup-fingerprint" | "dedup-ip-page";

/**
 * Pure dedup decision (no I/O): `false` + reason when this request is a
 * re-send of a view recorded inside the applicable window. Rules are
 * checked in privacy order — the fingerprint window is shorter and more
 * precise, so it wins the explanation.
 */
export function shouldCountView(args: ShouldCountViewArgs): {
  count: boolean;
  reason: DedupReason;
} {
  const fpWindow = args.fingerprintWindowMs ?? DEDUP_FINGERPRINT_WINDOW_MS;
  const ipWindow = args.ipPageWindowMs ?? DEDUP_IP_PAGE_WINDOW_MS;
  const nowMs = args.now.getTime();
  let ipPageHit = false;
  for (const row of args.recent) {
    const rowMs =
      row.viewed_at instanceof Date
        ? row.viewed_at.getTime()
        : Date.parse(row.viewed_at);
    if (Number.isNaN(rowMs)) continue;
    const age = nowMs - rowMs;
    if (
      args.fingerprint !== null &&
      row.viewer_fingerprint === args.fingerprint &&
      age >= 0 &&
      age <= fpWindow
    ) {
      return { count: false, reason: "dedup-fingerprint" };
    }
    if (
      !ipPageHit &&
      args.ipHash !== null &&
      row.viewer_ip === args.ipHash &&
      row.viewed_page === args.viewedPage &&
      age >= 0 &&
      age <= ipWindow
    ) {
      ipPageHit = true;
    }
  }
  if (ipPageHit) return { count: false, reason: "dedup-ip-page" };
  return { count: true, reason: "new" };
}

// ── recordView ───────────────────────────────────────────────────────────

/** User-Agent is stored capped — hostile UAs have hit 8k chars in the wild. */
const VIEWER_AGENT_MAX_LENGTH = 500;
/** A "read of my card" longer than an hour is a page left open, not a view. */
export const VIEW_DURATION_MAX_MS = 60 * 60_000;

export interface RecordViewInput {
  /** Requested page; snapped to the allowlist. */
  viewedPage: string;
  /** Raw viewer IP — hashed here, never persisted raw. */
  ip: string | null;
  userAgent: string | null;
  acceptLanguage?: string | null;
  /** Pre-sanitized via `parseReferrer` (or `null`). */
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  country?: string | null;
  city?: string | null;
  durationMs?: number | null;
  /** Pre-validated contact id, or `null` (see `resolveContactFromToken`). */
  resolvedContact?: string | null;
  /** True when the request carried an authenticated owner session. */
  authenticatedOwnerSession?: boolean;
  /** DNT/GPC: count the view but store only page, time and bot flag. */
  minimalPrivacy?: boolean;
  /** Base salt for the daily HMAC (`NETPRO_VIEW_SALT` or fallback). */
  baseSalt: string;
  /**
   * v3.0 Phase 2 — the workspace this view belongs to. Resolved
   * server-side from the viewed card (never from the request), so a
   * public beacon cannot pick a workspace. Absent = bootstrap workspace.
   */
  workspaceId?: string;
  /** Clock override for tests. */
  now?: Date;
}

export interface RecordViewResult {
  counted: boolean;
  reason: DedupReason;
  /** True when the row was labeled `is_owner_view`. */
  isOwnerView?: boolean;
  /** True when the row was labeled `is_bot`. */
  isBot?: boolean;
}

function cleanDuration(durationMs: number | null | undefined): number | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs))
    return null;
  const value = Math.round(durationMs);
  if (value < 0 || value > VIEW_DURATION_MAX_MS) return null;
  return value;
}

/**
 * Insert one profile view with every Phase 1 hardening applied. Never
 * throws on *bad input* (it normalizes); it may throw on storage failure,
 * which the beacon surfaces swallow — a broken database must not break the
 * visitor's page.
 */
export async function recordView(
  conn: Conn,
  input: RecordViewInput,
): Promise<RecordViewResult> {
  const now = input.now ?? new Date();
  const workspaceId = input.workspaceId ?? BOOTSTRAP_WORKSPACE_ID;
  const viewedPage = normalizeViewedPage(input.viewedPage);
  const minimal = Boolean(input.minimalPrivacy);
  const userAgent =
    typeof input.userAgent === "string" && input.userAgent.trim() !== ""
      ? input.userAgent.slice(0, VIEWER_AGENT_MAX_LENGTH)
      : null;

  const bot = classifyUserAgent(userAgent);
  const ipHash = input.ip
    ? hashViewerIp({
        ip: input.ip,
        userAgent,
        baseSalt: input.baseSalt,
        date: now,
      })
    : null;
  const fingerprint =
    !minimal && input.ip && userAgent
      ? hashViewerFingerprint({
          ip: input.ip,
          userAgent,
          acceptLanguage: input.acceptLanguage,
          baseSalt: input.baseSalt,
          date: now,
        })
      : null;

  const isOwnerView = shouldMarkOwnerView({
    authenticatedOwnerSession: Boolean(input.authenticatedOwnerSession),
    ipHash,
    recentOwnerIpHashes: ipHash
      ? await recentOwnerViewIpHashes(conn, { now, workspaceId })
      : [],
  });

  // One round trip covers both dedup rules: the probe only ever needs rows
  // inside the longer (1h) window, and the fingerprint rule re-checks its
  // shorter window in JS.
  //
  // The nullable parameters are wrapped in `CAST(… AS text)` on purpose.
  // Their only predicate is `IS NOT NULL`, from which Postgres cannot infer
  // a parameter type ("could not determine data type of parameter $2") —
  // the query fails server-side on every ingest. SQLite does not type-check
  // bind parameters, so every hermetic test passed while both beacons were
  // broken on Postgres deployments. The Docker smoke caught it at the
  // release gate (v2.5 Phase 7); the CAST is ANSI and a no-op semantically:
  // CAST(NULL AS text) IS NULL, CAST(value AS text) IS the value.
  const sinceIso = new Date(
    now.getTime() - DEDUP_IP_PAGE_WINDOW_MS,
  ).toISOString();
  const recent = await rawAll<DedupProbeRow>(
    conn,
    sql`SELECT viewer_fingerprint, viewer_ip, viewed_page, viewed_at
        FROM profile_views
        WHERE viewed_at >= ${sinceIso}
          AND workspace_id = ${workspaceId}
          AND (
            (CAST(${fingerprint} AS text) IS NOT NULL AND viewer_fingerprint = ${fingerprint})
            OR
            (CAST(${ipHash} AS text) IS NOT NULL AND viewer_ip = ${ipHash} AND viewed_page = ${viewedPage})
          )`,
  );
  const verdict = shouldCountView({
    fingerprint,
    ipHash,
    viewedPage,
    now,
    recent,
  });
  if (!verdict.count) return { counted: false, reason: verdict.reason };

  const referrer = minimal ? null : (input.referrer ?? null);
  const row = {
    id: randomUUID(),
    workspaceId,
    viewerIp: ipHash,
    viewerAgent: minimal ? null : userAgent,
    referrer,
    resolvedContact: minimal ? null : (input.resolvedContact ?? null),
    viewerFingerprint: fingerprint,
    isBot: bot.isBot,
    isOwnerView: isOwnerView,
    sessionId: randomBytes(8).toString("hex"),
    durationMs: minimal ? null : cleanDuration(input.durationMs),
    utmSource: minimal ? null : (input.utmSource ?? null),
    utmMedium: minimal ? null : (input.utmMedium ?? null),
    utmCampaign: minimal ? null : (input.utmCampaign ?? null),
    // Single owner card for now; the column exists for future cards.
    viewedCardId: null,
    viewedPage,
    viewedAt: now.toISOString(),
    country: minimal ? null : (input.country ?? null),
    city: minimal ? null : (input.city ?? null),
  };
  // The Drizzle builders differ between dialects, so pick by dialect
  // (the house pattern from Phase 1's card repository). The sqlite branch
  // needs an explicit terminal call — better-sqlite3 does not execute
  // until `.run()` (`.returning()` also works, but the row is not needed).
  if (conn.dialect === "sqlite") {
    conn.db.insert(conn.schema.profileViews).values(row).run();
  } else {
    await conn.db.insert(conn.schema.profileViews).values(row);
  }
  return {
    counted: true,
    reason: verdict.reason,
    isOwnerView,
    isBot: bot.isBot,
  };
}

// ── Signed contact-resolution tokens (`?v=`) ─────────────────────────────
//
// The owner can share a *personalized* card link, `/card?v=<token>`; when a
// known contact opens it, the view row records `resolved_contact` and the
// Phase 3 "who viewed" timeline can name them. The token is
// `base64url(contactId|exp|hmac)` with `hmac = HMAC-SHA256(secret, "contactId|exp")`,
// 30-day expiry cap, no state stored. Verification is offline (signature +
// expiry + charset); the caller additionally confirms the contact still
// exists via `findLiveContactId`. There is deliberately no path from an IP
// or an email to a contact — resolution is always owner-initiated.

/** Maximum token lifetime: 30 days. */
export const VIEW_TOKEN_TTL_MS = 30 * 86_400_000;
const CONTACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function b64urlEncode(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 512) return null;
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(value.length % 4);
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Mint a `?v=` token for one contact. `secret` is `NEXTAUTH_SECRET`; an
 * empty secret produces a token no verification will accept (and callers
 * should disable the feature instead).
 */
export function createContactViewToken(
  contactId: string,
  secret: string,
  now: Date = new Date(),
  ttlMs: number = VIEW_TOKEN_TTL_MS,
): string | null {
  if (!secret || !CONTACT_ID_PATTERN.test(contactId)) return null;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > VIEW_TOKEN_TTL_MS)
    return null;
  const exp = Math.floor((now.getTime() + ttlMs) / 1000);
  const payload = `${contactId}|${exp}`;
  const hmac = createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex");
  return b64urlEncode(Buffer.from(`${payload}|${hmac}`, "utf8"));
}

/**
 * Verify a `?v=` token. Returns the contact id when the format, signature
 * and expiry all check out; `null` otherwise. Expired tokens, wrong
 * signatures, unknown contact-id shapes, and missing secrets all fail
 * closed.
 */
export function resolveContactFromToken(
  token: string | null | undefined,
  args: { secret: string; now?: Date },
): string | null {
  if (typeof token !== "string" || !token || !args.secret) return null;
  const decoded = b64urlDecode(token.trim());
  if (!decoded) return null;
  const parts = decoded.toString("utf8").split("|");
  const [contactId, expRaw, hmac] = parts;
  if (
    parts.length !== 3 ||
    contactId === undefined ||
    expRaw === undefined ||
    hmac === undefined
  ) {
    return null;
  }
  if (!CONTACT_ID_PATTERN.test(contactId)) return null;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp)) return null;
  const now = args.now ?? new Date();
  if (exp * 1000 <= now.getTime()) return null; // expired
  if (exp * 1000 > now.getTime() + VIEW_TOKEN_TTL_MS + 86_400_000) {
    return null; // longer than a 30-day cap could ever be — forged/buggy
  }
  const expected = createHmac("sha256", args.secret)
    .update(`${contactId}|${exp}`, "utf8")
    .digest("hex");
  if (!timingSafeEqualHex(hmac, expected)) return null;
  return contactId;
}

/**
 * Resolve a token-claimed contact id to a *live* contact (exists and not
 * soft-deleted), or `null`. The token proves the owner minted a link for
 * this id; this proves the contact is still there. `workspaceId` (the
 * viewed card's workspace) additionally pins the lookup to that
 * workspace — a token minted in one workspace never resolves a contact
 * from another.
 */
export async function findLiveContactId(
  conn: Conn,
  contactId: string,
  workspaceId?: string,
): Promise<string | null> {
  const rows = await rawAll<{ id: string }>(
    conn,
    sql`SELECT id FROM contacts
        WHERE id = ${contactId} AND deleted_at IS NULL
          AND workspace_id = ${workspaceId ?? BOOTSTRAP_WORKSPACE_ID}`,
  );
  return rows[0]?.id ?? null;
}
