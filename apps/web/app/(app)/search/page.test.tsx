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
// Phase 12 — the page prefers the standalone server; tests pin the fallback
// by refusing the server by default, then opt into the server path per test.
type ServerFetchJsonMock = (
  path: string,
  options?: unknown,
) => Promise<{ ok: boolean; status: number; serverUrl: string; data: unknown }>;
const serverFetchJson = vi.hoisted(() =>
  vi.fn<ServerFetchJsonMock>(async () => {
    throw new Error("server down");
  }),
);

vi.mock("@/lib/db", () => ({ conn: fixture.conn }));
vi.mock("@/lib/netpro-server", () => ({
  getServerUrl: () => "http://127.0.0.1:3777",
  serverFetchJson,
}));
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
  serverFetchJson.mockReset();
  serverFetchJson.mockRejectedValue(new Error("server down"));
  fixture.sqlite.exec(
    "DELETE FROM search_index; DELETE FROM edges; DELETE FROM contacts;",
  );
  for (const row of [
    {
      id: "c1",
      fullName: "Jane Doe",
      company: "Stripe",
      role: "Senior Engineer",
      location: "Berlin",
      notes: "Introduced at PyCon",
      relationshipScore: 0.8,
      tags: ["founder"],
      skills: ["python"],
    },
    {
      id: "c2",
      fullName: "John Smith",
      company: "Acme",
      role: "Product Manager",
      location: "San Francisco",
      notes: null,
      relationshipScore: 0.3,
      tags: ["design"],
      skills: null,
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

describe("/search page — Phase 12 match reasons and filters", () => {
  it("shows why each result matched", async () => {
    const html = await render({ q: "stripe" });
    expect(html).toContain("Matched because:");
    expect(html).toContain("Works at Stripe");
  });

  it("renders skill and tag chips on every hit", async () => {
    const html = await render({});
    expect(html).toContain("#founder");
    expect(html).toContain("python");
    expect(html).toContain("strength 0.80");
  });

  it("filters by explicit name", async () => {
    const html = await render({ name: "john" });
    expect(html).toContain("John Smith");
    expect(html).not.toContain("Jane Doe");
  });

  it("filters by tags", async () => {
    const html = await render({ tags: "founder" });
    expect(html).toContain("Jane Doe");
    expect(html).not.toContain("John Smith");
    expect(html).toContain('Tagged &quot;founder&quot;');
  });

  it("filters by derived skills", async () => {
    const html = await render({ skills: "python" });
    expect(html).toContain("Jane Doe");
    expect(html).not.toContain("John Smith");
  });

  it("filters by relationship strength and cites it", async () => {
    const html = await render({ minScore: "0.5" });
    expect(html).toContain("Jane Doe");
    expect(html).not.toContain("John Smith");
    expect(html).toContain("Relationship strength 0.80 (minimum 0.5)");
  });

  it("ignores an unparseable minScore instead of erroring", async () => {
    const html = await render({ minScore: "bogus" });
    expect(html).toContain("Jane Doe");
    expect(html).toContain("John Smith");
  });

  it("filters by Louvain community once edges exist", async () => {
    fixture.conn.db
      .insert(fixture.conn.schema.edges)
      .values({
        id: "e1",
        sourceId: "c1",
        targetId: "c2",
        relation: "colleague",
        strength: 0.7,
        confidence: 1,
        bidirectional: true,
        source: "manual",
        status: "confirmed",
        discoveredAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const both = await render({ community: "0" });
    expect(both).toContain("Jane Doe");
    expect(both).toContain("John Smith");
    const none = await render({ community: "nope" });
    expect(none).toContain("No contacts match your search.");
  });

  it("falls back to local core when the server is unreachable", async () => {
    const html = await render({ q: "stripe" });
    expect(html).toContain("Jane Doe");
    expect(html).toContain("(local fallback)");
  });
});

describe("/search page — Phase 12 server path", () => {
  function serveSearch() {
    serverFetchJson.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/search")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: {
            contacts: [
              {
                id: "s1",
                fullName: "Server Sam",
                email: null,
                headline: null,
                company: "ServerCo",
                role: "CEO",
                seniority: null,
                industry: null,
                location: "Remote",
                linkedinUrl: null,
                relationshipScore: 0.9,
                lastInteraction: null,
                source: "test",
                tags: ["vip"],
                skills: ["python"],
                matchReasons: [
                  { kind: "company", text: "Works at ServerCo" },
                ],
              },
            ],
            total: 1,
            limit: 25,
            offset: 0,
            facets: {
              company: [],
              role: [],
              location: [],
              seniority: [],
              industry: [],
            },
            engine: {
              mode: "portable",
              requested: "portable",
              arms: {
                portable: { used: true, hits: 1 },
                keyword: { used: false, hits: 0, reason: "not_requested" },
                semantic: { used: false, hits: 0, reason: "not_requested" },
              },
              truncated: false,
            },
          },
        };
      }
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: { communities: { top: [{ label: "serverco" }] } },
      };
    });
  }

  it("renders server results and reasons without touching local core", async () => {
    serveSearch();
    const html = await render({ q: "sam" });
    expect(html).toContain("Server Sam");
    expect(html).toContain("Works at ServerCo");
    expect(html).toContain("#vip");
    expect(html).not.toContain("Jane Doe");
    expect(html).not.toContain("(local fallback)");
    // Community labels feed the datalist.
    expect(html).toContain('value="serverco"');
    // The page asked the server for exactly this search.
    const searchCall = serverFetchJson.mock.calls.find((call) =>
      String(call[0]).startsWith("/api/search"),
    );
    expect(searchCall).toBeDefined();
    expect(String(searchCall![0])).toContain("q=sam");
  });

  it("forwards every filter to the server query string", async () => {
    serveSearch();
    await render({
      q: "sam",
      name: "sam",
      company: "serverco",
      skills: "python",
      tags: "vip",
      community: "serverco",
      minScore: "0.5",
      sort: "score",
    });
    const searchCall = serverFetchJson.mock.calls.find((call) =>
      String(call[0]).startsWith("/api/search"),
    );
    const qs = String(searchCall![0]);
    for (const part of [
      "q=sam",
      "name=sam",
      "company=serverco",
      "skills=python",
      "tags=vip",
      "community=serverco",
      "minScore=0.5",
      "sort=score",
    ]) {
      expect(qs).toContain(part);
    }
  });
});
