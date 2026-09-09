// Live PostgreSQL coverage for the v2.5 view-beacon ingest path.
//
// WHY THIS FILE EXISTS. The Docker smoke at the v2.5 release gate caught a
// release-blocking bug every hermetic test had missed: the dedup probe in
// `recordView` used its nullable parameters ONLY inside `IS NOT NULL`, from
// which Postgres cannot infer a parameter type ("could not determine data
// type of parameter $2") — so every beacon ingest failed server-side on
// Postgres while passing on SQLite, where bind parameters are not
// type-checked. The pixel route swallowed the failure behind its
// always-200 contract; only the JSON beacon surfaced it, and only in a
// production build against a real server. This suite exists so the ingest
// path can never again be the one v2.5 surface whose SQL runs on exactly
// one dialect: every query `recordView` touches (the dedup probe, the
// owner-view DISTINCT probe, the insert) executes here against a real
// planner, with the dedup, privacy, owner-labeling, bot-labeling and token
// rules asserted on the rows that actually landed.
//
// SKIPPED unless NETPRO_TEST_DATABASE_URL points at a disposable server, so
// `npm test` stays hermetic and offline. CI's postgres job supplies it.
//
// ONE DATABASE, TESTS IN ORDER. All tests share one database and build on
// each other the way the content suite does. Viewer identities are chosen
// against the hashing model (fingerprint = HMAC(ip + UA + accept-language),
// ip hash = HMAC(ip + UA) — the UA is part of both, so "same visitor, new
// fingerprint" means varying the accept-language, not the UA). The final
// analytics test asserts the exact totals the whole file produced.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "@netpro/db/src/schema.pg";
import { runMigrations } from "@netpro/db";
import type { PgConn } from "@netpro/db";
import { rawAll } from "../search/indexer";
import {
  createContactViewToken,
  findLiveContactId,
  recordView,
  resolveContactFromToken,
} from "./beacon";
import { getViewsOverview } from "./analytics";
import type { RecordViewInput } from "./beacon";

const adminUrl = process.env.NETPRO_TEST_DATABASE_URL;
const describeIfPg = adminUrl ? describe : describe.skip;

const dbName = `netpro_core_views_${Date.now().toString(36)}`;
const SALT = "integration-view-salt";

/** Fixed clock; each test advances its own minute so dedup windows are exact. */
const NOW = new Date("2026-09-08T12:00:00.000Z");
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function viewInput(overrides: Partial<RecordViewInput>): RecordViewInput {
  return {
    viewedPage: "/card",
    ip: "10.1.0.1",
    userAgent: "integration-agent/1.0",
    acceptLanguage: "en",
    baseSalt: SALT,
    now: NOW,
    ...overrides,
  };
}

describeIfPg("view beacon ingest against live PostgreSQL", () => {
  let conn: PgConn;
  /**
   * Exact analytics expectations for the final test — every row the file
   * stores is accounted for here, in one place, so a change anywhere shows
   * up as a diff against these numbers.
   */
  const expected = {
    rows: 0, // every landed row, bots and owner views included
    views: 0, // counted, non-bot, non-owner
    unique: 0, // distinct COALESCE(fingerprint, ip hash, session)
    resolved: 0, // distinct resolved contacts
    bots: 0,
    ownerViews: 0,
    durations: [] as number[],
  };

  beforeAll(async () => {
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await client.query(`CREATE DATABASE "${dbName}"`);
    });
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    const pool = new Pool({ connectionString: url.toString() });
    conn = {
      dialect: "postgresql",
      db: drizzle(pool, { schema }),
      schema,
      pool,
    };
    await runMigrations(conn, { force: true });

    await conn.db.insert(schema.contacts).values([
      {
        id: "ada",
        fullName: "Ada Lovelace",
        email: "ada@engines.dev",
        source: "test",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
      {
        id: "gone",
        fullName: "Ghost Contact",
        email: "ghost@example.com",
        source: "test",
        deletedAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ]);
  }, 90_000);

  afterAll(async () => {
    await conn?.pool.end();
    await withAdmin(async (client) => {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [dbName],
      );
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    }).catch(() => {
      // Best effort cleanup of a throwaway database.
    });
  }, 120_000);

  it("records a new view with the Phase 1 hardening — and no raw IP", async () => {
    // This is the exact probe + insert pair that failed server-side before
    // the CAST fix: the nullable parameters ride only in IS NOT NULL, which
    // Postgres cannot type. If that regresses, the whole suite 500s here.
    const result = await recordView(
      conn,
      viewInput({
        ip: "10.1.1.1",
        userAgent: "agent-one/1.0",
        referrer: "https://blog.example/post",
        durationMs: 45_000,
        now: at(1),
      }),
    );
    expect(result).toEqual({ counted: true, reason: "new", isOwnerView: false, isBot: false });

    const rows = await rawAll<{
      viewer_ip: string | null;
      viewer_fingerprint: string | null;
      duration_ms: number | null;
      viewed_page: string;
      referrer: string | null;
      is_bot: boolean;
      is_owner_view: boolean;
    }>(
      conn,
      sql`SELECT viewer_ip, viewer_fingerprint, duration_ms, viewed_page, referrer, is_bot, is_owner_view
          FROM profile_views ORDER BY viewed_at DESC LIMIT 1`,
    );
    const row = rows[0]!;
    // Daily-salted 16-hex HMAC, never the raw address.
    expect(row.viewer_ip).toMatch(/^[0-9a-f]{16}$/);
    expect(row.viewer_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(row.duration_ms).toBe(45_000);
    expect(row.viewed_page).toBe("/card");
    expect(row.referrer).toBe("https://blog.example/post");
    expect(row.is_bot).toBe(false);
    expect(row.is_owner_view).toBe(false);

    const raw = await rawAll<{ n: string | number }>(
      conn,
      sql`SELECT COUNT(*) AS n FROM profile_views WHERE viewer_ip = ${"10.1.1.1"}`,
    );
    expect(Number(raw[0]!.n)).toBe(0);

    expected.rows += 1;
    expected.views += 1;
    expected.unique += 1;
    expected.durations.push(45_000);
  }, 60_000);

  it("dedupes the same fingerprint within the 5-minute window", async () => {
    const result = await recordView(
      conn,
      viewInput({ ip: "10.1.1.1", userAgent: "agent-one/1.0", now: at(2) }),
    );
    expect(result).toEqual({ counted: false, reason: "dedup-fingerprint" });

    // No row landed for the repeat.
    const rows = await rawAll<{ n: string | number }>(
      conn,
      sql`SELECT COUNT(*) AS n FROM profile_views`,
    );
    expect(Number(rows[0]!.n)).toBe(expected.rows);
  }, 60_000);

  it("dedupes the same IP + page within the 1-hour window — per page", async () => {
    // Same UA → same ip hash, different accept-language → different
    // fingerprint, so this arm exercises the ip_hash + viewed_page rule
    // (the second half of the probe's OR).
    const samePage = await recordView(
      conn,
      viewInput({ ip: "10.1.1.1", userAgent: "agent-one/1.0", acceptLanguage: "fr", now: at(3) }),
    );
    expect(samePage).toEqual({ counted: false, reason: "dedup-ip-page" });

    // The rule is per page: a different page from the same visitor counts.
    const otherPage = await recordView(
      conn,
      viewInput({
        ip: "10.1.1.1",
        userAgent: "agent-one/1.0",
        acceptLanguage: "fr",
        viewedPage: "blog",
        now: at(3),
      }),
    );
    expect(otherPage.counted).toBe(true);
    expect(otherPage.reason).toBe("new");

    expected.rows += 1;
    expected.views += 1;
    expected.unique += 1;
  }, 60_000);

  it("stores a DNT-minimal row: counted, but only page + time + bot flag", async () => {
    const result = await recordView(
      conn,
      viewInput({
        ip: "10.1.2.3",
        userAgent: "agent-dnt/1.0",
        referrer: "https://tracker.example/x",
        durationMs: 9_000,
        country: "DE",
        minimalPrivacy: true,
        now: at(4),
      }),
    );
    expect(result.counted).toBe(true);

    const rows = await rawAll<{
      viewer_ip: string | null;
      viewer_agent: string | null;
      viewer_fingerprint: string | null;
      referrer: string | null;
      duration_ms: number | null;
      country: string | null;
    }>(
      conn,
      sql`SELECT viewer_ip, viewer_agent, viewer_fingerprint, referrer, duration_ms, country
          FROM profile_views ORDER BY viewed_at DESC LIMIT 1`,
    );
    const row = rows[0]!;
    // The salted IP hash stays (dedup needs it); nothing else identifying.
    expect(row.viewer_ip).toMatch(/^[0-9a-f]{16}$/);
    expect(row.viewer_agent).toBeNull();
    expect(row.viewer_fingerprint).toBeNull();
    expect(row.referrer).toBeNull();
    expect(row.duration_ms).toBeNull();
    expect(row.country).toBeNull();

    expected.rows += 1;
    expected.views += 1;
    expected.unique += 1;
  }, 60_000);

  it("labels owner views — by session, then by the same-IP heuristic", async () => {
    const bySession = await recordView(
      conn,
      viewInput({
        ip: "10.1.3.4",
        userAgent: "agent-owner/1.0",
        viewedPage: "portfolio",
        authenticatedOwnerSession: true,
        now: at(5),
      }),
    );
    expect(bySession.isOwnerView).toBe(true);

    // Unauthenticated, but the same salted IP hash as the confirmed owner
    // view (same ip + UA; the language differs so the fingerprint — and the
    // 5-minute fingerprint rule — do not): the DISTINCT probe over recent
    // owner rows (more live-PG SQL that had never run before this suite)
    // feeds the heuristic.
    const byHeuristic = await recordView(
      conn,
      viewInput({
        ip: "10.1.3.4",
        userAgent: "agent-owner/1.0",
        acceptLanguage: "fr",
        viewedPage: "embed",
        now: at(6),
      }),
    );
    expect(byHeuristic.isOwnerView).toBe(true);

    const stranger = await recordView(
      conn,
      viewInput({ ip: "10.1.4.5", userAgent: "agent-stranger/1.0", viewedPage: "embed", now: at(7) }),
    );
    expect(stranger.isOwnerView).toBe(false);

    expected.rows += 3;
    expected.ownerViews += 2;
    expected.views += 1;
    expected.unique += 1;
  }, 60_000);

  it("labels bots, keeps the row, and analytics excludes it", async () => {
    const result = await recordView(
      conn,
      viewInput({
        ip: "10.1.5.6",
        userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        now: at(8),
      }),
    );
    expect(result.counted).toBe(true);
    expect(result.isBot).toBe(true);

    expected.rows += 1;
    expected.bots += 1;
  }, 60_000);

  it("resolves signed ?v= tokens to live contacts — and only to live contacts", async () => {
    const secret = "integration-token-secret";
    const token = createContactViewToken("ada", secret, at(9));
    expect(token).not.toBeNull();
    expect(resolveContactFromToken(token!, { secret, now: at(9) })).toBe("ada");

    const live = await findLiveContactId(conn, "ada");
    expect(live).toBe("ada");
    // A soft-deleted contact never resolves, token or no token.
    const dead = await findLiveContactId(conn, "gone");
    expect(dead).toBeNull();

    const resolved = await recordView(
      conn,
      viewInput({
        ip: "10.1.6.7",
        userAgent: "agent-ada/1.0",
        resolvedContact: live,
        now: at(9),
      }),
    );
    expect(resolved.counted).toBe(true);
    const resolvedRows = await rawAll<{ resolved_contact: string | null }>(
      conn,
      sql`SELECT resolved_contact FROM profile_views ORDER BY viewed_at DESC LIMIT 1`,
    );
    expect(resolvedRows[0]!.resolved_contact).toBe("ada");

    // The dead contact's id is null on ingest (the route passes what
    // findLiveContactId returned) — a deleted person leaves no attribution.
    const unresolved = await recordView(
      conn,
      viewInput({
        ip: "10.1.6.8",
        userAgent: "agent-gone/1.0",
        resolvedContact: null,
        now: at(10),
      }),
    );
    expect(unresolved.counted).toBe(true);

    expected.rows += 2;
    expected.views += 2;
    expected.unique += 2;
    expected.resolved += 1;
  }, 60_000);

  it("analytics read the exact rows back — bots and owner views excluded", async () => {
    const overview = await getViewsOverview(conn, { days: 30, limit: 10, now: at(11) });
    expect(overview.stats.totals.views).toBe(expected.views);
    expect(overview.stats.totals.uniqueViewers).toBe(expected.unique);
    expect(overview.stats.totals.resolvedContacts).toBe(expected.resolved);
    expect(overview.stats.excluded.bots).toBe(expected.bots);
    expect(overview.stats.excluded.ownerViews).toBe(expected.ownerViews);
    expect(overview.stats.series).toHaveLength(30);
    // Only the one row with a duration contributes to the average.
    const sum = expected.durations.reduce((a, b) => a + b, 0);
    expect(overview.stats.totals.avgDurationMs).toBe(Math.round(sum / expected.durations.length));

    // The known-visitor timeline names the token-resolved contact.
    const ada = overview.matches.matches.find((m) => m.contact.id === "ada");
    expect(ada).toBeDefined();
  }, 60_000);
});
