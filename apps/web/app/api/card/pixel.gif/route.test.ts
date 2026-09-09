import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createContactViewToken, hashViewerIp } from "@netpro/core/src/views";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
import { GET } from "./route";
import { auth } from "@/lib/auth";
import { beaconRateLimiter } from "@/lib/beacon";

const origin = "https://netpro.example";
const IP = "203.0.113.7";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const SALT = "unit-test-view-salt";
const SECRET = "unit-test-nextauth-secret";

function request(params = "", headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/api/card/pixel.gif${params}`, {
    headers: { "user-agent": UA, "x-forwarded-for": IP, ...headers },
  });
}

const storedRows = () =>
  fixture.sqlite.prepare("SELECT * FROM profile_views").all() as Array<
    Record<string, unknown>
  >;

function expectRow(
  rows: Array<Record<string, unknown>>,
): Record<string, unknown> {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error("expected exactly one row");
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(null as never);
  fixture.sqlite.prepare("DELETE FROM profile_views").run();
  fixture.sqlite.prepare("DELETE FROM contacts").run();
  fixture.sqlite
    .prepare(
      "INSERT INTO contacts (id, workspace_id, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "contact-1",
      "default",
      "Ada Lovelace",
      "csv",
      "2026-09-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
  beaconRateLimiter.reset();
  process.env.NETPRO_VIEW_SALT = SALT;
  process.env.NEXTAUTH_SECRET = SECRET;
  delete process.env.NETPRO_DISABLE_VIEWS;
});
afterAll(() => {
  delete process.env.NETPRO_VIEW_SALT;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.NETPRO_DISABLE_VIEWS;
  fixture.sqlite.close();
});

describe("GET /api/card/pixel.gif (v2.5 phase 2)", () => {
  it("returns a no-store 1x1 GIF and writes one hardened row", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const gif = new Uint8Array(await response.arrayBuffer());
    expect(gif).toHaveLength(42);
    expect(Buffer.from(gif.slice(0, 6)).toString()).toBe("GIF89a");
    expect(gif[gif.length - 1]).toBe(0x3b); // GIF trailer ';'

    const row = expectRow(storedRows());
    expect(row).toBeDefined();
    // The salted hash for (IP, UA) under the configured salt — never the raw IP.
    expect(row.viewer_ip).toBe(
      hashViewerIp({ ip: IP, userAgent: UA, baseSalt: SALT }),
    );
    expect(row.viewer_ip).toMatch(/^[0-9a-f]{16}$/);
    expect(row.viewer_agent).toBe(UA);
    expect(row.viewed_page).toBe("/card");
    expect(row.is_bot).toBe(0);
    expect(row.is_owner_view).toBe(0);
    expect(JSON.stringify(row)).not.toContain(IP);
  });

  it("never logs the raw IP, even in server logs (v2.5 phase 6)", async () => {
    const lines: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        lines.push(args.join(" "));
      });
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation((...args: unknown[]) => {
        lines.push(args.join(" "));
      });
    try {
      await GET(request());
      for (const line of lines) expect(line).not.toContain(IP);
    } finally {
      logSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("labels bots and owner sessions without changing the response", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "owner" } } as never);
    const response = await GET(
      request("", {
        "user-agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      }),
    );
    expect(response.status).toBe(200);
    const row = expectRow(storedRows());
    expect(row.is_bot).toBe(1);
    expect(row.is_owner_view).toBe(1);
  });

  it("stores referrer without its query tokens, and capped UTM values", async () => {
    await GET(
      request(
        `?r=https://blog.example/post/42?next=%2Fcard&token=SECRET&utm_medium=rss&utm_campaign=${"x".repeat(150)}`,
      ),
    );
    const row = expectRow(storedRows());
    expect(row.referrer).toBe("https://blog.example/post/42");
    expect(String(row)).not.toContain("SECRET");
    expect(row.utm_medium).toBe("rss");
    expect(row.utm_campaign).toHaveLength(100);
  });

  it("caps hostile p= values to the allowlist", async () => {
    await GET(request(`?p=${encodeURIComponent("../../etc/passwd")}`));
    const row = expectRow(storedRows());
    expect(row.viewed_page).toBe("/card");
  });

  it("honours DNT: still counted, but only page + time + bot flag are stored", async () => {
    await GET(request("", { dnt: "1", "x-vercel-ip-country": "GB" }));
    const row = expectRow(storedRows());
    expect(row.viewer_agent).toBeNull();
    expect(row.referrer).toBeNull();
    expect(row.country).toBeNull();
    expect(row.viewer_fingerprint).toBeNull();
    expect(row.viewed_page).toBe("/card");
    expect(row.viewer_ip).toMatch(/^[0-9a-f]{16}$/);
  });

  it("resolves a signed ?v= token to a live contact, and nothing else", async () => {
    const good = createContactViewToken("contact-1", SECRET);
    // Minted under a different secret: must not resolve.
    const forged = createContactViewToken("contact-1", "other-secret");
    const ghost = createContactViewToken("missing-contact", SECRET);

    await GET(request(`?v=${encodeURIComponent(good ?? "")}`));
    expect(expectRow(storedRows()).resolved_contact).toBe("contact-1");
    fixture.sqlite.prepare("DELETE FROM profile_views").run();

    await GET(request(`?v=${encodeURIComponent(forged ?? "")}`));
    expect(expectRow(storedRows()).resolved_contact).toBeNull();
    fixture.sqlite.prepare("DELETE FROM profile_views").run();

    await GET(request(`?v=${encodeURIComponent(ghost ?? "")}`));
    expect(expectRow(storedRows()).resolved_contact).toBeNull();
    fixture.sqlite.prepare("DELETE FROM profile_views").run();

    await GET(request("?v=not-a-token"));
    expect(expectRow(storedRows()).resolved_contact).toBeNull();
  });

  it("rate limits to 60 requests per minute per IP, answering 429 with the GIF", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await GET(request())).status).toBe(200);
    }
    const denied = await GET(request());
    expect(denied.status).toBe(429);
    expect(denied.headers.get("content-type")).toBe("image/gif");
    // 61 requests, 1 row: the first 60 all describe the same view, so the
    // dedup window collapses them — the limiter still consumed the budget
    // for every request, which is what the 429 proves.
    expect(storedRows()).toHaveLength(1);
  });

  it("returns the GIF but writes nothing (and reads no session) when disabled", async () => {
    process.env.NETPRO_DISABLE_VIEWS = "true";
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(storedRows()).toHaveLength(0);
    expect(auth).not.toHaveBeenCalled();
  });
});
