vi.mock("@/lib/authz", () => ({
  requireMembership: async () => ({
    workspaceId: "default",
    userId: "test-user",
    role: "member",
  }),
  requireScope: async () => ({
    workspaceId: "default",
    userId: "test-user",
    role: "owner",
  }),
}));
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
const semanticAvailable = vi.hoisted(() => vi.fn(() => false));
const embedder = vi.hoisted(() => vi.fn(() => null as unknown));

vi.mock("@/lib/db", () => ({ conn: fixture.conn }));
vi.mock("@/lib/search-config", () => ({
  semanticSearchAvailable: semanticAvailable,
  searchEmbedder: embedder,
  searchEmbeddingsConfig: () => ({ provider: "disabled" }),
}));

import SearchPage from "./page";
import { reindexSearchIndex } from "@netpro/core/src/search";

const NOW = new Date("2026-09-07T12:00:00Z").toISOString();

async function render(params: Record<string, string> = {}): Promise<string> {
  const element = await SearchPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

beforeEach(() => {
  semanticAvailable.mockReturnValue(false);
  embedder.mockReturnValue(null);
  fixture.sqlite.exec("DELETE FROM search_index; DELETE FROM contacts;");
  for (const row of [
    {
      id: "c1",
      fullName: "Jane Doe",
      company: "Stripe",
      role: "Senior Engineer",
      location: "Berlin",
      notes: "Introduced at PyCon",
    },
    {
      id: "c2",
      fullName: "John Smith",
      company: "Vercel",
      role: "Product Manager",
      location: "San Francisco",
      notes: null,
    },
  ]) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ ...row, source: "test", createdAt: NOW, updatedAt: NOW })
      .run();
  }
});
afterAll(() => fixture.sqlite.close());

describe("/search page — engine selector", () => {
  it("defaults to exact match and shows no engine badge", async () => {
    const html = await render({ q: "stripe" });
    expect(html).toContain("Jane Doe");
    expect(html).toContain('value="portable"');
    expect(html).not.toContain("Results powered by");
  });

  it("hides the semantic option when no embeddings key is configured", async () => {
    const html = await render({ q: "stripe" });
    expect(html).toContain(">Smart (full-text)</option>");
    expect(html).not.toContain('value="hybrid"');
  });

  it("offers the semantic option once the server has a key", async () => {
    semanticAvailable.mockReturnValue(true);
    const html = await render({ q: "stripe" });
    expect(html).toContain('value="hybrid"');
    expect(html).toContain(">Smart + semantic</option>");
  });

  it("ignores an unrecognised ?mode= instead of erroring", async () => {
    const html = await render({ q: "stripe", mode: "vector" });
    expect(html).toContain("Jane Doe");
    expect(html).not.toContain("Results powered by");
  });
});

describe("/search page — engine badge", () => {
  it("tells the owner to build the index when it is empty", async () => {
    const html = await render({ q: "stripe", mode: "keyword" });
    expect(html).toContain("Results powered by substring matching");
    expect(html).toContain("netpro reindex");
    // …and still shows the results the portable engine found.
    expect(html).toContain("Jane Doe");
  });

  it("reports full-text search once the index exists", async () => {
    await reindexSearchIndex(fixture.conn);
    const html = await render({ q: "stripe", mode: "keyword" });
    expect(html).toContain("Results powered by full-text search");
    expect(html).not.toContain("netpro reindex");
  });

  it("surfaces an indexed-notes match that exact search misses", async () => {
    await reindexSearchIndex(fixture.conn);
    expect(await render({ q: "pycon" })).toContain(
      "No contacts match your search.",
    );
    const html = await render({ q: "pycon", mode: "keyword" });
    expect(html).toContain("Jane Doe");
  });

  it("explains a missing embeddings key on a hybrid request", async () => {
    await reindexSearchIndex(fixture.conn);
    const html = await render({ q: "stripe", mode: "hybrid" });
    expect(html).toContain("EMBEDDINGS_API_KEY");
  });

  it("asks for a reindex when a key exists but no vectors do", async () => {
    semanticAvailable.mockReturnValue(true);
    embedder.mockReturnValue({
      id: "openai",
      model: "fake-model",
      embed: async (texts: string[]) => texts.map(() => [1, 0]),
    });
    await reindexSearchIndex(fixture.conn);
    const html = await render({ q: "stripe", mode: "hybrid" });
    expect(html).toContain("netpro reindex --embeddings");
  });

  it("reports the hybrid engine when both arms run", async () => {
    const fake = {
      id: "openai" as const,
      model: "fake-model",
      embed: async (texts: string[]) =>
        texts.map((t) => [t.includes("stripe") ? 1 : 0, 1]),
    };
    semanticAvailable.mockReturnValue(true);
    embedder.mockReturnValue(fake);
    await reindexSearchIndex(fixture.conn, { embedder: fake });
    const html = await render({ q: "stripe", mode: "hybrid" });
    expect(html).toContain("Results powered by full-text + vector search");
  });

  it("preserves the mode across the filter form", async () => {
    await reindexSearchIndex(fixture.conn);
    const html = await render({ q: "stripe", mode: "keyword" });
    expect(html).toContain('name="mode" value="keyword"');
  });
});
