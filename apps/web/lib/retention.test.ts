// v2.5 Phase 6 — the web-side retention schedule: env knobs (lenient by
// design) and the start-up + 24 h cadence, self-guarded by the audit log.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RETENTION_PURGE_ACTION } from "@netpro/core/src/retention";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});

import {
  retentionConfig,
  retentionDisabled,
  scheduleRetentionPurge,
} from "./retention";

function purgeRows(): Array<{ created_at: string; metadata: string | null }> {
  return fixture.sqlite
    .prepare("SELECT created_at, metadata FROM activity_log WHERE action = ?")
    .all(RETENTION_PURGE_ACTION) as Array<{
    created_at: string;
    metadata: string | null;
  }>;
}

/** Seed relative to the REAL clock — the schedule does not take a `now`. */
function seedPurgeRun(hoursAgo: number): void {
  fixture.conn.db
    .insert(fixture.conn.schema.activityLog)
    .values({
      id: `seeded-${hoursAgo}`,
      action: RETENTION_PURGE_ACTION,
      entityType: "retention",
      metadata: null,
      createdAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    })
    .run();
}

function seedExpiredData(): void {
  fixture.conn.db
    .insert(fixture.conn.schema.profileViews)
    .values({
      id: "old-view",
      isBot: false,
      isOwnerView: false,
      viewedPage: "/card",
      viewedAt: "2025-01-01T00:00:00.000Z", // ~20 months back
    })
    .run();
}

beforeEach(() => {
  fixture.sqlite.exec(
    "DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items; DELETE FROM profile_views; DELETE FROM activity_log;",
  );
});

afterAll(() => fixture.sqlite.close());

describe("retentionDisabled (v2.5 phase 6)", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["1", false],
    ["yes", false],
    ["true", true],
    ["True", true],
    [" true ", true],
  ])("NETPRO_DISABLE_RETENTION=%j → %j", (value, expected) => {
    expect(retentionDisabled({ NETPRO_DISABLE_RETENTION: value })).toBe(
      expected,
    );
  });
});

describe("retentionConfig (v2.5 phase 6)", () => {
  it("defaults to enabled with the shipped 90 / 365 / 30-day windows", () => {
    expect(retentionConfig({})).toEqual({
      enabled: true,
      viewRetentionDays: 90,
      contentMetricRetentionDays: 365,
      webhookDeliveryRetentionDays: 30,
    });
  });

  it("honors explicit positive integer windows", () => {
    expect(
      retentionConfig({
        NETPRO_VIEW_RETENTION_DAYS: "30",
        NETPRO_CONTENT_METRIC_RETENTION_DAYS: "100",
        NETPRO_WEBHOOK_DELIVERY_RETENTION_DAYS: "14",
      }),
    ).toEqual({
      enabled: true,
      viewRetentionDays: 30,
      contentMetricRetentionDays: 100,
      webhookDeliveryRetentionDays: 14,
    });
  });

  it("floors fractional windows", () => {
    expect(
      retentionConfig({ NETPRO_VIEW_RETENTION_DAYS: "12.7" }).viewRetentionDays,
    ).toBe(12);
  });

  it("falls back to the defaults for garbage, zero and negative values", () => {
    for (const garbage of ["abc", "0", "-5", "inf", "NaN"]) {
      expect(
        retentionConfig({
          NETPRO_VIEW_RETENTION_DAYS: garbage,
          NETPRO_CONTENT_METRIC_RETENTION_DAYS: garbage,
          NETPRO_WEBHOOK_DELIVERY_RETENTION_DAYS: garbage,
        }),
      ).toEqual({
        enabled: true,
        viewRetentionDays: 90,
        contentMetricRetentionDays: 365,
        webhookDeliveryRetentionDays: 30,
      });
    }
  });

  it("reports disabled when the kill switch is on", () => {
    expect(retentionConfig({ NETPRO_DISABLE_RETENTION: "true" }).enabled).toBe(
      false,
    );
  });
});

describe("scheduleRetentionPurge (v2.5 phase 6)", () => {
  it("does nothing when retention is disabled", async () => {
    seedExpiredData();
    const result = scheduleRetentionPurge(fixture.conn, {
      NETPRO_DISABLE_RETENTION: "true",
    });
    expect(result).toEqual({ started: false });
    await vi.waitFor(() => expect(purgeRows()).toHaveLength(0));
    // The expired row is untouched — no schedule, no purge.
    expect(
      fixture.sqlite
        .prepare("SELECT COUNT(*) AS n FROM profile_views")
        .get() as { n: number },
    ).toEqual({ n: 1 });
  });

  it("runs the purge at start-up and audits it with counts", async () => {
    seedExpiredData();
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const result = scheduleRetentionPurge(fixture.conn, {});
      expect(result).toEqual({ started: true });

      await vi.waitFor(() => expect(purgeRows()).toHaveLength(1));
      const row = purgeRows()[0]!;
      expect(JSON.parse(row.metadata!)).toMatchObject({
        profileViewsDeleted: 1,
      });
      expect(
        fixture.sqlite
          .prepare("SELECT COUNT(*) AS n FROM profile_views")
          .get() as { n: number },
      ).toEqual({ n: 0 });
      // The run is announced with counts, not per-row.
      expect(consoleInfo).toHaveBeenCalledTimes(1);
      expect(consoleInfo.mock.calls[0]![0]).toContain("retention purge");
      expect(consoleInfo.mock.calls[0]![0]).toContain("1 profile view(s)");
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("no-ops when a purge ran within the last 24 h (cold-start storm)", async () => {
    seedPurgeRun(12); // twelve hours ago
    seedExpiredData();
    const result = scheduleRetentionPurge(fixture.conn, {});
    expect(result).toEqual({ started: true });

    await new Promise((r) => setTimeout(r, 50)); // let the (skipped) run settle
    expect(purgeRows()).toHaveLength(1); // only the seeded row
    expect(
      fixture.sqlite
        .prepare("SELECT COUNT(*) AS n FROM profile_views")
        .get() as { n: number },
    ).toEqual({ n: 1 }); // nothing deleted — the day is not over
  });

  it("swallows a purge failure instead of throwing at the server", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let threw = false;
    try {
      // A bogus connection: the purge must fail inside the schedule, never
      // surface synchronously (the caller is the instrumentation hook).
      scheduleRetentionPurge(
        { dialect: "sqlite", db: null, schema: null } as never,
        {},
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(errorSpy.mock.calls[0]![0]).toContain("retention purge failed");
    errorSpy.mockRestore();
  });
});
