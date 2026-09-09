import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/authz", () => ({
  requireScope: async () => ({
    workspaceId: "default",
    role: "owner",
    userId: "system",
  }),
}));
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { DELETE, POST } from "./route";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();

beforeEach(() => {
  fixture.sqlite.exec(
    "DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items; DELETE FROM activity_log; DELETE FROM contacts;",
  );
  for (const r of [
    {
      id: "a",
      fullName: "Ada Lovelace",
      email: "ada@engines.dev",
      company: "Engines",
      industry: "fintech",
      relationshipScore: 0.9,
    },
    {
      id: "b",
      fullName: "Bob Builder",
      email: "bob@builders.io",
      company: "Builders",
      industry: "fintech",
      relationshipScore: 0.6,
    },
  ]) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ ...r, source: "test", createdAt: NOW_ISO, updatedAt: NOW_ISO })
      .run();
  }
});
afterAll(() => fixture.sqlite.close());

async function seedItem(): Promise<string> {
  const { upsertContentItem } = await import("@netpro/core/src/content");
  const { item } = await upsertContentItem(
    fixture.conn,
    {
      url: "https://example.dev/blog/one",
      title: "Blog one",
      platform: "blog",
      publishedAt: "2026-09-01",
    },
    { now: NOW },
  );
  return item.id;
}

const post = (id: string, body: unknown) =>
  POST(
    new Request(
      `http://localhost/api/content/${encodeURIComponent(id)}/mentions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ id }) },
  );
const del = (id: string, qs: string) =>
  DELETE(
    new Request(
      `http://localhost/api/content/${encodeURIComponent(id)}/mentions${qs}`,
      { method: "DELETE" },
    ),
    {
      params: Promise.resolve({ id }),
    },
  );

interface MentionBody {
  mention: {
    contactId: string;
    fullName: string;
    context: string | null;
    email: string | null;
  };
  created: boolean;
}

describe("POST /api/content/[id]/mentions", () => {
  it("links a contact by id, email or exact name", async () => {
    const id = await seedItem();
    for (const selector of [
      { contactId: "a" },
      { contact: "ada@engines.dev" },
      { contact: "Ada Lovelace" },
    ]) {
      const res = await post(id, selector);
      expect(res.status).toBe(201);
      const body = (await res.json()) as MentionBody;
      expect(body.mention.contactId).toBe("a");
    }
    // One row, not three: the mention dedupes on (content, contact).
    const rows = fixture.sqlite
      .prepare("SELECT COUNT(*) AS n FROM content_mentions")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("records a context, and re-adding with one updates it", async () => {
    const id = await seedItem();
    const first = (await (
      await post(id, { contact: "a", context: "co-authored" })
    ).json()) as MentionBody;
    expect(first.mention.context).toBe("co-authored");
    const second = (await (
      await post(id, { contact: "a", context: "reviewed by" })
    ).json()) as MentionBody;
    expect(second.created).toBe(false);
    expect(second.mention.context).toBe("reviewed by");
  });

  it("400s an ambiguous name instead of guessing", async () => {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({
        id: "a2",
        fullName: "Ada Lovelace",
        email: "ada2@engines.dev",
        company: "Engines",
        industry: "fintech",
        relationshipScore: 0.5,
        source: "test",
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      })
      .run();
    const id = await seedItem();
    const res = await post(id, { contact: "Ada Lovelace" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      'Ambiguous contact "Ada Lovelace"',
    );
  });

  it("404s an unknown contact or content", async () => {
    const id = await seedItem();
    const noContact = await post(id, { contact: "nobody@nowhere.dev" });
    expect(noContact.status).toBe(404);
    const noContent = await post("nope", { contactId: "a" });
    expect(noContent.status).toBe(404);
  });

  it("rejects a missing selector or an over-long context", async () => {
    const id = await seedItem();
    expect((await post(id, {})).status).toBe(400);
    expect(
      (await post(id, { contact: "a", context: "x".repeat(121) })).status,
    ).toBe(400);
  });
});

describe("DELETE /api/content/[id]/mentions", () => {
  it("removes one mention", async () => {
    const id = await seedItem();
    await post(id, { contact: "a" });
    await post(id, { contact: "b" });
    const res = await del(id, "?contactId=a");
    expect(res.status).toBe(200);
    const rows = fixture.sqlite
      .prepare("SELECT COUNT(*) AS n FROM content_mentions")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("removes by email selector too", async () => {
    const id = await seedItem();
    await post(id, { contact: "a" });
    const res = await del(id, "?contact=ada@engines.dev");
    expect(res.status).toBe(200);
    const rows = fixture.sqlite
      .prepare("SELECT COUNT(*) AS n FROM content_mentions")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("is a no-op when the mention is already gone", async () => {
    const id = await seedItem();
    const res = await del(id, "?contactId=a");
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { mention: { removed: boolean } }).mention.removed,
    ).toBe(false);
  });

  it("400s a missing selector and 404s unknown content", async () => {
    const id = await seedItem();
    expect((await del(id, "")).status).toBe(400);
    expect((await del("nope", "?contactId=a")).status).toBe(404);
  });
});
