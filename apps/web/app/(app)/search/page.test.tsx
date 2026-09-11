import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Phase 24 — the search page is a pure client of GET /api/search (plus
// /api/providers for the semantic toggle and /api/graph for the community
// datalist). It has no direct-DB fallback, so tests mock only the server
// client.
type ServerFetchJsonMock = (
  path: string,
  options?: unknown,
) => Promise<{ ok: boolean; status: number; serverUrl: string; data: unknown }>;

const serverFetchJson = vi.hoisted(() => vi.fn<ServerFetchJsonMock>());

vi.mock("@/lib/netpro-server", () => ({
  getServerUrl: () => "http://127.0.0.1:3777",
  serverFetchJson,
}));

import SearchPage from "./page";

async function render(params: Record<string, string> = {}): Promise<string> {
  const element = await SearchPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

const SEARCH_RESULTS = {
  contacts: [
    {
      id: "s1",
      fullName: "Server Sam",
      email: null,
      company: "ServerCo",
      role: "CEO",
      location: "Remote",
      relationshipScore: 0.9,
      tags: ["vip"],
      skills: ["python"],
      matchReasons: [{ kind: "company", text: "Works at ServerCo" }],
    },
  ],
  total: 1,
  limit: 25,
  offset: 0,
  facets: {
    company: [{ value: "ServerCo", count: 1 }],
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
};

function serveSearch(overrides: Record<string, unknown> = {}) {
  serverFetchJson.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/providers")) {
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: {
          capabilities: { keywordSearch: "available", semanticSearch: "disabled" },
        },
      };
    }
    if (path.startsWith("/api/search")) {
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: { ...SEARCH_RESULTS, ...overrides },
      };
    }
    if (path.startsWith("/api/graph")) {
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: { communities: { top: [{ label: "serverco" }] } },
      };
    }
    throw new Error(`unexpected path ${path}`);
  });
}

beforeEach(() => {
  serverFetchJson.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/search page — server client (Phase 24)", () => {
  it("renders server results, match reasons, and chips", async () => {
    serveSearch();
    const html = await render({ q: "sam" });
    expect(html).toContain("Server Sam");
    expect(html).toContain("Works at ServerCo");
    expect(html).toContain("#vip");
    expect(html).toContain("python");
    expect(html).toContain("strength 0.90");
    // Community labels feed the datalist.
    expect(html).toContain('value="serverco"');
    // No local-fallback language remains.
    expect(html).not.toContain("(local fallback)");
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

  it("hides the semantic option when the server reports it disabled", async () => {
    serveSearch();
    const html = await render({ q: "sam" });
    expect(html).toContain(">Smart (full-text)</option>");
    expect(html).not.toContain('value="hybrid"');
  });

  it("offers the semantic option when the server reports it available", async () => {
    serveSearch();
    serverFetchJson.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/providers")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: { capabilities: { keywordSearch: "available", semanticSearch: "available" } },
        };
      }
      if (path.startsWith("/api/search")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: SEARCH_RESULTS,
        };
      }
      if (path.startsWith("/api/graph")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: { communities: { top: [] } },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const html = await render({ q: "sam" });
    expect(html).toContain('value="hybrid"');
    expect(html).toContain(">Smart + semantic</option>");
  });

  it("ignores an unrecognised ?mode= instead of erroring", async () => {
    serveSearch();
    const html = await render({ q: "sam", mode: "vector" });
    expect(html).toContain("Server Sam");
    expect(html).not.toContain('name="mode" value="vector"');
  });

  it("renders the engine badge from the server report", async () => {
    serveSearch({
      engine: {
        mode: "keyword",
        requested: "keyword",
        arms: {
          portable: { used: true, hits: 1 },
          keyword: { used: false, hits: 0, reason: "index_empty" },
          semantic: { used: false, hits: 0, reason: "not_requested" },
        },
        truncated: false,
      },
    });
    const html = await render({ q: "sam", mode: "keyword" });
    expect(html).toContain("Results powered by full-text search");
    expect(html).toContain("netpro reindex");
    // Results still render alongside the badge.
    expect(html).toContain("Server Sam");
  });

  it("explains a missing embeddings key on a hybrid request", async () => {
    serveSearch({
      engine: {
        mode: "hybrid",
        requested: "hybrid",
        arms: {
          portable: { used: true, hits: 1 },
          keyword: { used: true, hits: 1, reason: "ok" },
          semantic: { used: false, hits: 0, reason: "not_configured" },
        },
        truncated: false,
      },
    });
    const html = await render({ q: "sam", mode: "hybrid" });
    expect(html).toContain("EMBEDDINGS_API_KEY");
  });

  it("shows a banner when the server is unreachable", async () => {
    serverFetchJson.mockRejectedValue(new Error("ECONNREFUSED"));
    const html = await render({ q: "sam" });
    expect(html).toContain("Server not reachable");
    expect(html).toContain("netpro serve");
  });
});
