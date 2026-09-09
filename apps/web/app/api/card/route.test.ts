import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPublishedCard } from "@netpro/core/src/card/repository";
import { MAX_PROFILE_BYTES } from "@netpro/core/src/card/types";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));
const mockRequireScope = vi.hoisted(() => vi.fn());
vi.mock("@/lib/authz", () => ({ requireScope: mockRequireScope }));
import { conn } from "@/lib/db";
import { DELETE, GET, POST, PUT } from "./route";

const ownerScope = { workspaceId: "default", role: "owner", userId: "owner" };
const profile = { fullName: "Public Ada", email: "public@example.com" };
const origin = "https://netpro.example";
function request(
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${origin}/api/card`, {
    method,
    headers: { origin, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockRequireScope.mockResolvedValue(ownerScope);
  if (conn.dialect === "sqlite") await conn.db.delete(conn.schema.profileCards);
});
afterAll(() => fixture.sqlite.close());

describe("owner card API", () => {
  it.each([GET, PUT, POST, DELETE])(
    "checks auth in the handler, not just middleware",
    async (handler) => {
      mockRequireScope.mockRejectedValue(
        Object.assign(new Error("Unauthorized"), { status: 401 }),
      );
      const response = await handler(request("POST", profile));
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await getPublishedCard(conn)).toBeNull();
    },
  );

  it("implements the complete private draft / public snapshot lifecycle", async () => {
    expect(await (await GET()).json()).toMatchObject({
      draft: null,
      published: null,
    });
    const saved = await PUT(request("PUT", profile));
    expect(saved.status).toBe(200);
    expect(await getPublishedCard(conn)).toBeNull();
    const published = await POST(request("POST", profile));
    expect(published.status).toBe(200);
    expect(published.headers.get("cache-control")).toContain("no-store");
    await PUT(
      request("PUT", {
        fullName: "Private next version",
        email: "private@example.com",
      }),
    );
    expect(await getPublishedCard(conn)).toMatchObject(profile);
    const deleted = await DELETE(request("DELETE"));
    expect(await deleted.json()).toMatchObject({
      published: null,
      publishedAt: null,
      draft: { fullName: "Private next version" },
    });
    expect(await getPublishedCard(conn)).toBeNull();
  });

  it.each([PUT, POST, DELETE])(
    "rejects cross-origin and missing-origin mutations",
    async (handler) => {
      expect(
        (
          await handler(
            request("POST", profile, { origin: "https://attacker.example" }),
          )
        ).status,
      ).toBe(403);
      const noOrigin = request("POST", profile);
      noOrigin.headers.delete("origin");
      expect((await handler(noOrigin)).status).toBe(403);
    },
  );

  it("accepts a same-origin request behind a trusted HTTPS reverse proxy", async () => {
    const proxied = new Request("http://localhost:3000/api/card", {
      method: "PUT",
      body: JSON.stringify(profile),
      headers: {
        origin,
        "content-type": "application/json",
        "x-forwarded-host": "netpro.example",
        "x-forwarded-proto": "https",
      },
    });
    expect((await PUT(proxied)).status).toBe(200);
  });

  it("rejects invalid JSON, empty/array bodies, and unsafe fields", async () => {
    const malformed = new Request(`${origin}/api/card`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{",
    });
    expect((await POST(malformed)).status).toBe(400);
    for (const body of [
      null,
      [],
      {},
      { ...profile, notes: "private" },
      { ...profile, links: [{ label: "X", url: "javascript:alert(1)" }] },
    ]) {
      expect((await POST(request("POST", body))).status).toBe(400);
    }
    expect(await getPublishedCard(conn)).toBeNull();
  });

  it("requires application/json rather than accepting cross-site form data", async () => {
    expect(
      (await POST(request("POST", profile, { "content-type": "text/plain" })))
        .status,
    ).toBe(415);
  });

  it("bounds content length and actual streamed bytes even when the header lies", async () => {
    expect(
      (
        await POST(
          request("POST", profile, {
            "content-length": String(MAX_PROFILE_BYTES + 1),
          }),
        )
      ).status,
    ).toBe(413);
    const big = request(
      "POST",
      { ...profile, bio: "x".repeat(MAX_PROFILE_BYTES) },
      { "content-length": "1" },
    );
    expect((await POST(big)).status).toBe(413);
    const chunked = new Request(`${origin}/api/card`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_PROFILE_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect((await POST(chunked)).status).toBe(413);
  });

  it("returns generic storage errors, not database internals or profile data", async () => {
    const select = vi.spyOn(conn.db, "select").mockImplementation(() => {
      throw new Error("SECRET DATABASE CONNECTION");
    });
    try {
      const response = await GET();
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("SECRET");
    } finally {
      select.mockRestore();
    }
  });
});
