// v2.5 Phase 6 — the startup hook: migrations and the daily retention
// schedule, in the right order, on the right runtime, with the right knobs.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RETENTION_PURGE_ACTION } from "@netpro/core/src/retention";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { register } from "./instrumentation";

const ENV_KEYS = [
  "NEXT_RUNTIME",
  "NETPRO_AUTO_MIGRATE",
  "NETPRO_DISABLE_RETENTION",
  "NETPRO_VIEW_RETENTION_DAYS",
  "NETPRO_CONTENT_METRIC_RETENTION_DAYS",
] as const;

function purgeRows(): Array<unknown> {
  return fixture.sqlite
    .prepare("SELECT id FROM activity_log WHERE action = ?")
    .all(RETENTION_PURGE_ACTION) as Array<unknown>;
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  fixture.sqlite.exec("DELETE FROM activity_log; DELETE FROM profile_views;");
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(() => fixture.sqlite.close());

describe("instrumentation register() (v2.5 phase 6)", () => {
  it("does nothing on the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await register();
    await new Promise((r) => setTimeout(r, 50));
    expect(purgeRows()).toHaveLength(0);
  });

  it("schedules the retention purge after the startup migrations", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await register();
      await vi.waitFor(() => expect(purgeRows()).toHaveLength(1));
      // The first boot of a fresh deployment purges immediately: the audit
      // row carries the (empty) counts, not per-row detail.
      expect(
        consoleInfo.mock.calls.some((c) =>
          String(c[0]).includes("retention purge"),
        ),
      ).toBe(true);
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("still schedules retention when auto-migration is off (DML, not DDL)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NETPRO_AUTO_MIGRATE = "false";
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await register();
      expect(
        consoleInfo.mock.calls.some((c) =>
          String(c[0]).includes("skipping startup migrations"),
        ),
      ).toBe(true);
      await vi.waitFor(() => expect(purgeRows()).toHaveLength(1));
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("starts no schedule when retention is disabled", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NETPRO_DISABLE_RETENTION = "true";
    await register();
    await new Promise((r) => setTimeout(r, 50));
    expect(purgeRows()).toHaveLength(0);
  });
});
