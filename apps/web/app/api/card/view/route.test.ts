import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
import { OPTIONS, POST } from "./route";
import { auth } from "@/lib/auth";
import { beaconRateLimiter } from "@/lib/beacon";

const origin = "https://netpro.example";
const IP = "203.0.113.7";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

function call(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(`${origin}/api/card/view`, {
      method: "POST",
      headers: {
        "user-agent": UA,
        "x-forwarded-for": IP,
        "content-type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
    }),
  );
}

const storedRows = () =>
  fixture.sqlite
    .prepare("SELECT * FROM profile_views")
    .all() as Array<Record<string, unknown>>;

function expectRow(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error("expected exactly one row");
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(null as never);
  fixture.sqlite.prepare("DELETE FROM profile_views").run();
  beaconRateLimiter.reset();
  delete process.env.NETPRO_DISABLE_VIEWS;
});
afterAll(() => {
  delete process.env.NETPRO_DISABLE_VIEWS;
  fixture.sqlite.close();
});

describe("POST /api/card/view (v2.5 phase 2)", () => {
  it("accepts the JS beacon payload and records duration", async () => {
    const response = await call({
      page: "/card",
      referrer: "https://blog.example/post/42?token=SECRET",
      durationMs: 45_000,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ counted: true, reason: "new" });

    const row = expectRow(storedRows());
    expect(row.viewed_page).toBe("/card");
    expect(row.duration_ms).toBe(45_000);
    expect(row.referrer).toBe("https://blog.example/post/42");
    expect(JSON.stringify(row)).not.toContain("SECRET");
    expect(JSON.stringify(row)).not.toContain(IP);
  });

  it("answers CORS preflights for cross-origin embeds", () => {
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "POST, OPTIONS",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects the wrong content type with 415 and non-objects with 400", async () => {
    const text = await call("hello", { "content-type": "text/plain" });
    expect(text.status).toBe(415);
    const noType = await call("{}", { "content-type": "" });
    expect(noType.status).toBe(415);
    const array = await call("[1,2,3]");
    expect(array.status).toBe(400);
    const garbage = await call("{not json");
    expect(garbage.status).toBe(400);
    expect(storedRows()).toHaveLength(0);
  });

  it("rejects oversized and out-of-range payloads with 400", async () => {
    const oversized = await call({ pad: "x".repeat(8 * 1024) });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: expect.any(String) });
    const long = await call({ durationMs: 3_600_001 });
    expect(long.status).toBe(400);
    const negative = await call({ durationMs: -1 });
    expect(negative.status).toBe(400);
    const notANumber = await call({ durationMs: "fast" });
    expect(notANumber.status).toBe(400);
    const badPage = await call({ page: 42 });
    expect(badPage.status).toBe(400);
    const longToken = await call({ viewToken: "x".repeat(513) });
    expect(longToken.status).toBe(400);
    expect(storedRows()).toHaveLength(0);
  });

  it("sanitizes body referrers and caps page values to the allowlist", async () => {
    const response = await call({
      page: "../../etc/passwd",
      referrer: "javascript:alert(1)",
    });
    expect(response.status).toBe(200);
    const row = expectRow(storedRows());
    expect(row.viewed_page).toBe("/card");
    expect(row.referrer).toBeNull();
  });

  it("rate limits like the pixel (shared per-IP budget)", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await call({ page: "/card" })).status).toBe(200);
    }
    const denied = await call({ page: "/card" });
    expect(denied.status).toBe(429);
    expect(storedRows()).toHaveLength(1);
  });

  it("answers honestly but stores nothing when tracking is disabled", async () => {
    process.env.NETPRO_DISABLE_VIEWS = "true";
    const response = await call({ page: "/card", durationMs: 1234 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ counted: false, reason: "disabled" });
    expect(storedRows()).toHaveLength(0);
  });
});
