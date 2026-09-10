import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireMembership } = vi.hoisted(() => ({ mockRequireMembership: vi.fn() }));
const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/authz", () => ({ requireMembership: mockRequireMembership }));
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureEntry, fixtureIndex } from "@netpro/core/src/plugins/testing";
import { GET } from "./route";

const adminScope = { userId: "tester", workspaceId: "default", role: "admin" } as const;
let savedIndexUrl: string | undefined;
let savedCachePath: string | undefined;
let savedNoCache: string | undefined;

beforeEach(() => {
  fixture.sqlite.exec("DELETE FROM plugins; DELETE FROM activity_log;");
  mockRequireMembership.mockReset();
  mockRequireMembership.mockResolvedValue(adminScope);
  savedIndexUrl = process.env.MARKETPLACE_INDEX_URL;
  savedCachePath = process.env.MARKETPLACE_CACHE_PATH;
  savedNoCache = process.env.MARKETPLACE_NO_CACHE;
  process.env.MARKETPLACE_CACHE_PATH = join(mkdtempSync(join(tmpdir(), "netpro-web-cache-")), "cache.json");
  delete process.env.MARKETPLACE_NO_CACHE;
});

afterEach(() => {
  if (savedIndexUrl === undefined) delete process.env.MARKETPLACE_INDEX_URL;
  else process.env.MARKETPLACE_INDEX_URL = savedIndexUrl;
  if (savedCachePath === undefined) delete process.env.MARKETPLACE_CACHE_PATH;
  else process.env.MARKETPLACE_CACHE_PATH = savedCachePath;
  if (savedNoCache === undefined) delete process.env.MARKETPLACE_NO_CACHE;
  else process.env.MARKETPLACE_NO_CACHE = savedNoCache;
});

afterAll(() => fixture.sqlite.close());

function writeIndex(entries: ReturnType<typeof fixtureEntry>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "netpro-web-market-"));
  const file = join(dir, "index.json");
  writeFileSync(file, JSON.stringify(fixtureIndex(entries)), "utf8");
  return file;
}

const get = (qs = "") => GET(new Request(`http://localhost/api/plugins/marketplace${qs}`));

describe("GET /api/plugins/marketplace (Phase 6)", () => {
  it("lists entries for admins", async () => {
    const file = writeIndex([fixtureEntry({ name: "web-demo", description: "Web demo plugin" })]);
    process.env.MARKETPLACE_INDEX_URL = pathToFileURL(file).href;
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: Array<{ name: string }>; updatedAt: string; fromCache: boolean };
    expect(body.plugins.map((p) => p.name)).toEqual(["web-demo"]);
    expect(body.fromCache).toBe(false);
    rmSync(join(file, ".."), { recursive: true, force: true });
  });

  it("filters with ?q= and bypasses the cache with ?refresh=1", async () => {
    const file = writeIndex([
      fixtureEntry({ name: "alpha-one", description: "first" }),
      fixtureEntry({ name: "beta-two", description: "second" }),
    ]);
    process.env.MARKETPLACE_INDEX_URL = pathToFileURL(file).href;
    const filtered = (await (await get("?q=alpha")).json()) as { plugins: Array<{ name: string }> };
    expect(filtered.plugins.map((p) => p.name)).toEqual(["alpha-one"]);
    const refreshed = (await (await get("?refresh=1")).json()) as { plugins: unknown[]; fromCache: boolean };
    expect(refreshed.plugins).toHaveLength(2);
    expect(refreshed.fromCache).toBe(false);
    rmSync(join(file, ".."), { recursive: true, force: true });
  });

  it("maps a broken index to 502, not a stack trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "netpro-web-market-"));
    const file = join(dir, "index.json");
    writeFileSync(file, "{oops", "utf8");
    process.env.MARKETPLACE_INDEX_URL = pathToFileURL(file).href;
    const res = await get("?refresh=1");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("enforces the admin floor", async () => {
    mockRequireMembership.mockRejectedValue(Object.assign(new Error("Forbidden: requires admin role"), { status: 403 }));
    const res = await get();
    expect(res.status).toBe(403);
    mockRequireMembership.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
    expect((await get()).status).toBe(401);
  });
});
