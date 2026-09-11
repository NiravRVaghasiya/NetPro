import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SqliteConn } from "@netpro/db";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import {
  VIEW_DURATION_MAX_MS,
  VIEW_TOKEN_TTL_MS,
  VIEWED_PAGES,
  createContactViewToken,
  extractViewerGeo,
  extractViewerIp,
  findLiveContactId,
  isDntRequest,
  normalizeViewedPage,
  recordView,
  resolveContactFromToken,
  shouldCountView,
  type BeaconHeaders,
} from "./beacon";

const SALT = "netpro-beacon-test-salt";
const IP = "203.0.113.7";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const NOW = new Date("2026-09-08T10:00:00.000Z");

function headers(obj: Record<string, string>): BeaconHeaders {
  return { get: (name: string) => obj[name.toLowerCase()] ?? null };
}

/** Pull the single row a test just wrote; fails loudly on 0 or 2+. */
function singleRow<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error("expected exactly one row");
  return row;
}

describe("viewed page allowlist (v2.5 phase 2)", () => {
  it("exposes the plan-mandated set and snaps unknown values to /card", () => {
    expect(VIEWED_PAGES).toEqual([
      "/card",
      "/card/vcard",
      "blog",
      "portfolio",
      "embed",
    ]);
    for (const page of VIEWED_PAGES) {
      expect(normalizeViewedPage(page)).toBe(page);
      expect(normalizeViewedPage(`  ${page}  `)).toBe(page);
    }
  });

  it("caps hostile input to the allowlist instead of storing or throwing", () => {
    expect(normalizeViewedPage("../../etc/passwd")).toBe("/card");
    expect(normalizeViewedPage("/card?v=../../x")).toBe("/card");
    expect(normalizeViewedPage("javascript:alert(1)")).toBe("/card");
    expect(normalizeViewedPage(null)).toBe("/card");
    expect(normalizeViewedPage(undefined)).toBe("/card");
  });
});

describe("header extraction (v2.5 phase 2)", () => {
  it("takes the FIRST X-Forwarded-For entry and validates it as an IP", () => {
    const h = headers({
      "x-forwarded-for": "203.0.113.7, 10.0.0.1, 172.16.0.1",
    });
    expect(extractViewerIp(h)).toBe("203.0.113.7");
  });

  it('treats an invalid first hop as "no IP" rather than reading proxy hops', () => {
    const h = headers({ "x-forwarded-for": "spoofed, 203.0.113.7" });
    expect(extractViewerIp(h)).toBeNull();
    const empty = headers({ "x-forwarded-for": ",,," });
    expect(extractViewerIp(empty)).toBeNull();
  });

  it("falls back to X-Real-Ip and accepts IPv6", () => {
    expect(extractViewerIp(headers({ "x-real-ip": "198.51.100.23" }))).toBe(
      "198.51.100.23",
    );
    expect(extractViewerIp(headers({ "x-forwarded-for": "2001:db8::1" }))).toBe(
      "2001:db8::1",
    );
    expect(extractViewerIp(headers({ "x-real-ip": "not-an-ip" }))).toBeNull();
    expect(extractViewerIp(headers({}))).toBeNull();
  });

  it("reads geo from generic or Cloudflare proxy headers, capped and trimmed", () => {
    expect(
      extractViewerGeo(
        headers({
          "x-geo-country": "GB",
          "x-geo-city": "London",
        }),
      ),
    ).toEqual({ country: "GB", city: "London" });
    expect(extractViewerGeo(headers({ "cf-ipcountry": "US" }))).toEqual({
      country: "US",
      city: null,
    });
    expect(
      extractViewerGeo(headers({ "x-geo-country": "x".repeat(100) })),
    ).toEqual({
      country: "x".repeat(64),
      city: null,
    });
    expect(extractViewerGeo(headers({ "x-geo-country": "  " }))).toEqual({
      country: null,
      city: null,
    });
  });

  it("records no geo at all when the proxy sends nothing (phase 4)", () => {
    // A self-hosted deployment that has not configured its proxy records no
    // location — NetPro never infers one from platform-specific headers.
    expect(extractViewerGeo(headers({}))).toEqual({ country: null, city: null });
    // Unknown platform-specific spellings are not guessed: only the generic
    // pair, Cloudflare's pair, or caller-configured names are read.
    expect(
      extractViewerGeo(headers({ "x-platform-ip-country": "GB" })),
    ).toEqual({ country: null, city: null });
  });

  it("accepts custom header names for other proxies", () => {
    expect(
      extractViewerGeo(
        headers({ "x-country-code": "DE", "x-city-name": "Berlin" }),
        { countryHeaders: ["x-country-code"], cityHeaders: ["x-city-name"] },
      ),
    ).toEqual({ country: "DE", city: "Berlin" });
  });

  it("flags DNT and Sec-GPC requests for minimal storage mode", () => {
    expect(isDntRequest(headers({ dnt: "1" }))).toBe(true);
    expect(isDntRequest(headers({ "sec-gpc": "1" }))).toBe(true);
    expect(isDntRequest(headers({ dnt: "0" }))).toBe(false);
    expect(isDntRequest(headers({ "user-agent": UA }))).toBe(false);
  });
});

describe("dedup decision (v2.5 phase 2)", () => {
  const row = (
    fingerprint: string | null,
    viewerIp: string | null,
    page: string,
    viewedAt: string,
  ) => ({
    viewer_fingerprint: fingerprint,
    viewer_ip: viewerIp,
    viewed_page: page,
    viewed_at: viewedAt,
  });

  it("skips the same fingerprint within 5 minutes", () => {
    const verdict = shouldCountView({
      fingerprint: "f".repeat(16),
      ipHash: "a".repeat(16),
      viewedPage: "/card",
      now: NOW,
      recent: [
        row(
          "f".repeat(16),
          "a".repeat(16),
          "/card",
          "2026-09-08T09:58:00.000Z",
        ),
      ],
    });
    expect(verdict).toEqual({ count: false, reason: "dedup-fingerprint" });
  });

  it("allows the same fingerprint once the 5-minute window has passed", () => {
    // Different page too: same IP + page within 1h would still dedup, and
    // this test isolates the fingerprint rule on purpose.
    const verdict = shouldCountView({
      fingerprint: "f".repeat(16),
      ipHash: "a".repeat(16),
      viewedPage: "blog",
      now: NOW,
      recent: [
        row(
          "f".repeat(16),
          "a".repeat(16),
          "/card",
          "2026-09-08T09:54:00.000Z",
        ),
      ],
    });
    expect(verdict).toEqual({ count: true, reason: "new" });
  });

  it("skips the same IP hash + page within 1 hour even with a different fingerprint", () => {
    const verdict = shouldCountView({
      fingerprint: "b".repeat(16),
      ipHash: "a".repeat(16),
      viewedPage: "/card",
      now: NOW,
      recent: [
        row(
          "f".repeat(16),
          "a".repeat(16),
          "/card",
          "2026-09-08T09:30:00.000Z",
        ),
      ],
    });
    expect(verdict).toEqual({ count: false, reason: "dedup-ip-page" });
  });

  it("counts the same IP on a different page, and another IP on the same page", () => {
    const sameIpOtherPage = shouldCountView({
      fingerprint: "b".repeat(16),
      ipHash: "a".repeat(16),
      viewedPage: "blog",
      now: NOW,
      recent: [
        row(
          "f".repeat(16),
          "a".repeat(16),
          "/card",
          "2026-09-08T09:58:00.000Z",
        ),
      ],
    });
    expect(sameIpOtherPage.count).toBe(true);
    const otherIpSamePage = shouldCountView({
      fingerprint: "b".repeat(16),
      ipHash: "c".repeat(16),
      viewedPage: "/card",
      now: NOW,
      recent: [
        row(
          "f".repeat(16),
          "a".repeat(16),
          "/card",
          "2026-09-08T09:58:00.000Z",
        ),
      ],
    });
    expect(otherIpSamePage.count).toBe(true);
  });

  it("honours configurable windows and ignores future-dated junk rows", () => {
    const verdict = shouldCountView({
      fingerprint: "f".repeat(16),
      ipHash: "a".repeat(16),
      viewedPage: "/card",
      now: NOW,
      recent: [
        row(
          "f".repeat(16),
          "a".repeat(16),
          "/card",
          "2026-09-09T10:00:00.000Z",
        ),
      ],
      fingerprintWindowMs: 60_000,
    });
    expect(verdict.count).toBe(true);
  });
});

describe("recordView — the profile_views producer (v2.5 phase 2)", () => {
  let conn: SqliteConn;
  let sqlite: ReturnType<typeof createTestSqliteConn>["sqlite"];

  beforeEach(async () => {
    ({ conn, sqlite } = createTestSqliteConn());
  });
  afterAll(() => {
    if (sqlite) sqlite.close();
  });

  const addContactTo = (c: SqliteConn, id: string) => {
    c.db
      .insert(c.schema.contacts)
      .values({
        id,
        fullName: "Ada Lovelace",
        source: "csv",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
  };

  const base = {
    viewedPage: "/card",
    ip: IP,
    userAgent: UA,
    baseSalt: SALT,
    now: NOW,
  };

  it("records a hardened row: salted hashes, no raw IP anywhere", async () => {
    const result = await recordView(conn, {
      ...base,
      acceptLanguage: "en-US,en;q=0.9",
      referrer: "https://blog.example/post/42",
      utmSource: "twitter",
      utmMedium: "social",
      utmCampaign: "launch",
      country: "GB",
      city: "London",
      durationMs: 42_500,
    });
    expect(result).toMatchObject({
      counted: true,
      reason: "new",
      isBot: false,
      isOwnerView: false,
    });

    const stored = singleRow(
      sqlite.prepare("SELECT * FROM profile_views").all() as Array<
        Record<string, unknown>
      >,
    );
    expect(stored.viewer_ip).toMatch(/^[0-9a-f]{16}$/);
    expect(stored.viewer_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(stored.viewer_agent).toBe(UA);
    expect(stored.referrer).toBe("https://blog.example/post/42");
    expect(stored.utm_source).toBe("twitter");
    expect(stored.utm_medium).toBe("social");
    expect(stored.utm_campaign).toBe("launch");
    expect(stored.country).toBe("GB");
    expect(stored.city).toBe("London");
    expect(stored.duration_ms).toBe(42_500);
    expect(stored.viewed_page).toBe("/card");
    expect(stored.viewed_at).toBe(NOW.toISOString());
    expect(stored.is_bot).toBe(0);
    expect(stored.is_owner_view).toBe(0);
    expect(typeof stored.session_id).toBe("string");
    // The privacy promise: the raw IP appears in NO column of the row.
    const blob = Object.values(stored)
      .map((v) => String(v ?? ""))
      .join("|");
    expect(blob).not.toContain(IP);
  });

  it("labels bots and owner sessions without refusing the view", async () => {
    const bot = await recordView(conn, {
      ...base,
      userAgent:
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    });
    expect(bot).toMatchObject({
      counted: true,
      isBot: true,
      isOwnerView: false,
    });

    const owner = await recordView(conn, {
      ...base,
      ip: "198.51.100.99",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0",
      authenticatedOwnerSession: true,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(owner).toMatchObject({ counted: true, isOwnerView: true });
  });

  it("applies the same-IP owner heuristic to later unauthenticated views", async () => {
    await recordView(conn, { ...base, authenticatedOwnerSession: true });
    // Two hours later: outside the 1h dedup window (so it counts), inside
    // the 24h owner lookback (so it is labeled the owner).
    const later = await recordView(conn, {
      ...base,
      now: new Date(NOW.getTime() + 2 * 60 * 60_000),
    });
    expect(later).toMatchObject({ counted: true, isOwnerView: true });
  });

  it("dedups rapid re-sends of the same view with an explanatory reason", async () => {
    await recordView(conn, base);
    const reload = await recordView(conn, {
      ...base,
      now: new Date(NOW.getTime() + 2 * 60_000),
    });
    expect(reload).toEqual({ counted: false, reason: "dedup-fingerprint" });

    // Same IP + UA (same person-ish hash) but a different accept-language,
    // so the fingerprint differs: the 1h IP-hash + page window still
    // catches the re-send (this is the pixel + JS-beacon double fire).
    const secondBeacon = await recordView(conn, {
      ...base,
      acceptLanguage: "de-DE,de;q=0.9",
      now: new Date(NOW.getTime() + 3 * 60_000),
    });
    expect(secondBeacon).toEqual({ counted: false, reason: "dedup-ip-page" });

    // A genuinely different person (different UA → different person-ish
    // hash) on the same IP is a new view, even within the hour.
    const otherBrowser = await recordView(conn, {
      ...base,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; rv:126.0) Gecko/20100101 Firefox/126.0",
      now: new Date(NOW.getTime() + 3 * 60_000),
    });
    expect(otherBrowser).toMatchObject({ counted: true, reason: "new" });

    // Other people always count, whatever the page.
    const blog = await recordView(conn, {
      ...base,
      viewedPage: "blog",
      ip: "198.51.100.50",
    });
    expect(blog.counted).toBe(true);
    const otherIp = await recordView(conn, { ...base, ip: "198.51.100.51" });
    expect(otherIp.counted).toBe(true);

    expect(
      (
        sqlite.prepare("SELECT count(*) AS n FROM profile_views").get() as {
          n: number;
        }
      ).n,
    ).toBe(4);
  });

  it("stores only page, time and bot flag in DNT/GPC minimal mode", async () => {
    const result = await recordView(conn, {
      ...base,
      minimalPrivacy: true,
      acceptLanguage: "en",
      referrer: "https://blog.example/post/42",
      utmSource: "should-not-store",
      country: "GB",
      city: "London",
      durationMs: 1234,
      resolvedContact: "contact-x",
    });
    expect(result.counted).toBe(true);
    const stored = singleRow(
      sqlite.prepare("SELECT * FROM profile_views").all() as Array<
        Record<string, unknown>
      >,
    );
    expect(stored.viewer_agent).toBeNull();
    expect(stored.referrer).toBeNull();
    expect(stored.utm_source).toBeNull();
    expect(stored.country).toBeNull();
    expect(stored.city).toBeNull();
    expect(stored.duration_ms).toBeNull();
    expect(stored.resolved_contact).toBeNull();
    expect(stored.viewer_fingerprint).toBeNull();
    // Still counted, still time-stamped, still salted (never raw).
    expect(stored.viewed_page).toBe("/card");
    expect(stored.viewed_at).toBe(NOW.toISOString());
    expect(stored.viewer_ip).toMatch(/^[0-9a-f]{16}$/);
    expect(String(stored.viewer_ip)).not.toContain(IP);
  });

  it("clamps duration to a sane bound and normalizes the page", async () => {
    await recordView(conn, {
      ...base,
      durationMs: VIEW_DURATION_MAX_MS + 1,
      viewedPage: "x/../etc",
    });
    const stored = singleRow(
      sqlite
        .prepare("SELECT duration_ms, viewed_page FROM profile_views")
        .all() as Array<{
        duration_ms: number | null;
        viewed_page: string;
      }>,
    );
    expect(stored.duration_ms).toBeNull();
    expect(stored.viewed_page).toBe("/card");
  });

  it("works with no IP at all (null hashes, still counted, no dedup key)", async () => {
    const result = await recordView(conn, { ...base, ip: null });
    expect(result).toMatchObject({ counted: true, reason: "new" });
    const stored = singleRow(
      sqlite
        .prepare("SELECT viewer_ip, viewer_fingerprint FROM profile_views")
        .all() as Array<{ viewer_ip: string | null }>,
    );
    expect(stored.viewer_ip).toBeNull();
    // Without an IP/fingerprint the 5-minute rule cannot apply — a second
    // request from the same no-IP client counts again (route-level rate
    // limiting covers the abuse case).
    const again = await recordView(conn, {
      ...base,
      ip: null,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(again.counted).toBe(true);
  });

  it("stores a validated resolved contact id", async () => {
    addContactTo(conn, "contact-1");
    await recordView(conn, { ...base, resolvedContact: "contact-1" });
    const stored = singleRow(
      sqlite
        .prepare("SELECT resolved_contact FROM profile_views")
        .all() as Array<{ resolved_contact: string | null }>,
    );
    expect(stored.resolved_contact).toBe("contact-1");
  });
});

describe("signed ?v= contact-resolution tokens (v2.5 phase 2)", () => {
  const SECRET = "unit-test-nextauth-secret";
  const CONTACT_ID = "c0ffee-1234";

  it("round-trips a freshly minted token", () => {
    const token = createContactViewToken(CONTACT_ID, SECRET, NOW);
    expect(token).not.toBeNull();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(resolveContactFromToken(token, { secret: SECRET, now: NOW })).toBe(
      CONTACT_ID,
    );
  });

  it("expires and rejects wrong secrets, tampering, and garbage", () => {
    const token = createContactViewToken(CONTACT_ID, SECRET, NOW);
    expect(
      resolveContactFromToken(token, {
        secret: SECRET,
        now: new Date(NOW.getTime() + VIEW_TOKEN_TTL_MS + 1000),
      }),
    ).toBeNull();
    expect(
      resolveContactFromToken(token, { secret: "other-secret", now: NOW }),
    ).toBeNull();
    const [payload] = token!.split("");
    const tampered = (payload === "A" ? "B" : "A") + token!.slice(1);
    expect(
      resolveContactFromToken(tampered, { secret: SECRET, now: NOW }),
    ).toBeNull();
    expect(
      resolveContactFromToken("not-a-token", { secret: SECRET, now: NOW }),
    ).toBeNull();
    expect(
      resolveContactFromToken("", { secret: SECRET, now: NOW }),
    ).toBeNull();
    expect(
      resolveContactFromToken(null, { secret: SECRET, now: NOW }),
    ).toBeNull();
    expect(resolveContactFromToken(token, { secret: "", now: NOW })).toBeNull();
  });

  it("refuses to mint for bad contact ids or oversized TTLs", () => {
    expect(
      createContactViewToken("bad id with spaces", SECRET, NOW),
    ).toBeNull();
    expect(createContactViewToken("", SECRET, NOW)).toBeNull();
    expect(createContactViewToken(CONTACT_ID, "", NOW)).toBeNull();
    expect(
      createContactViewToken(CONTACT_ID, SECRET, NOW, VIEW_TOKEN_TTL_MS + 1),
    ).toBeNull();
  });

  it("rejects hand-forged tokens whose expiry exceeds the 30-day cap", () => {
    const farFuture = Math.floor((NOW.getTime() + 90 * 86_400_000) / 1000);
    const hmac = createHmac("sha256", SECRET)
      .update(`${CONTACT_ID}|${farFuture}`, "utf8")
      .digest("hex");
    const forged = Buffer.from(`${CONTACT_ID}|${farFuture}|${hmac}`, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      resolveContactFromToken(forged, { secret: SECRET, now: NOW }),
    ).toBeNull();
  });
});

describe("findLiveContactId (v2.5 phase 2)", () => {
  let conn: SqliteConn;
  let sqlite: ReturnType<typeof createTestSqliteConn>["sqlite"];

  beforeEach(async () => {
    ({ conn, sqlite } = createTestSqliteConn());
  });
  afterAll(() => {
    if (sqlite) sqlite.close();
  });

  const addContact = (id: string, deletedAt: string | null = null) => {
    sqlite
      .prepare(
        "INSERT INTO contacts (id, workspace_id, full_name, source, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        "default",
        "Ada Lovelace",
        "csv",
        NOW.toISOString(),
        NOW.toISOString(),
        deletedAt,
      );
  };

  it("resolves live contacts only (exists and not soft-deleted)", async () => {
    addContact("live-1");
    addContact("gone-1", "2026-01-01T00:00:00.000Z");
    expect(await findLiveContactId(conn, "live-1")).toBe("live-1");
    expect(await findLiveContactId(conn, "gone-1")).toBeNull();
    expect(await findLiveContactId(conn, "missing")).toBeNull();
  });
});
