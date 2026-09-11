import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Phase 24 — the pathfinder page is a pure client of the NetPro server
// (GET /api/graph/path, GET /api/graph, GET /api/search for the picklist).
// It has no direct-DB fallback, so tests mock only the server client.
type ServerFetchJsonMock = (
  path: string,
  options?: unknown,
) => Promise<{ ok: boolean; status: number; serverUrl: string; data: unknown }>;

const serverFetchJson = vi.hoisted(() => vi.fn<ServerFetchJsonMock>());

vi.mock("@/lib/netpro-server", () => ({
  getServerUrl: () => "http://127.0.0.1:3777",
  serverFetchJson,
}));

import PathfinderPage from "./page";

async function render(params: Record<string, string> = {}): Promise<string> {
  const element = await PathfinderPage({
    searchParams: Promise.resolve(params),
  });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

beforeEach(() => {
  serverFetchJson.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const PLAN = {
  target: { contactId: "c", fullName: "Cara Chen", company: null, role: null },
  origin: {
    contactId: "a",
    fullName: "Ada Lovelace",
    company: null,
    role: null,
    relationshipScore: 0.9,
    lastInteraction: null,
    selectedBy: "explicit",
  },
  maxDepth: 4,
  found: true,
  unreachable: false,
  paths: [
    {
      hops: 2,
      path: [
        {
          contactId: "a",
          fullName: "Ada Lovelace",
          company: null,
          role: null,
          relationshipScore: 0.9,
          lastInteraction: null,
          via: null,
        },
        {
          contactId: "b",
          fullName: "Bob Builder",
          company: null,
          role: null,
          relationshipScore: 0.8,
          lastInteraction: null,
          via: {
            relations: ["colleague"],
            minConfidence: 1,
            minStrength: 0.8,
            oneWay: false,
          },
        },
        {
          contactId: "c",
          fullName: "Cara Chen",
          company: null,
          role: null,
          relationshipScore: 0.7,
          lastInteraction: null,
          via: {
            relations: ["colleague"],
            minConfidence: 1,
            minStrength: 0.8,
            oneWay: false,
          },
        },
      ],
      intermediaries: [
        {
          contactId: "b",
          fullName: "Bob Builder",
          company: null,
          role: null,
          relationshipScore: 0.8,
          lastInteraction: null,
        },
      ],
      rank: 1,
      score: { weakestTie: 0.8, avgHopStrength: 0.8, score: 0.8 },
      ask: {
        contactId: "a",
        fullName: "Ada Lovelace",
        relationshipScore: 0.9,
        lastInteraction: null,
        askForId: "b",
        askForName: "Bob Builder",
        adjacentToTarget: false,
        suggestion: "Ask Ada Lovelace to connect you with Bob Builder.",
      },
    },
  ],
};

function serveGraph(overrides: Record<string, unknown> = {}) {
  serverFetchJson.mockImplementation(async (path: string) => {
    const p = String(path);
    if (p.startsWith("/api/graph/path")) {
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: { ...PLAN, ...overrides },
      };
    }
    if (p.startsWith("/api/graph")) {
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: {
          nodes: 3,
          edges: 2,
          warmIntros: [
            {
              contactId: "a",
              contactName: "Ada Lovelace",
              targetId: "c",
              targetName: "Cara Chen",
              viaId: "b",
              viaName: "Bob Builder",
              hops: 2,
            },
          ],
        },
      };
    }
    if (p.startsWith("/api/search")) {
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: { contacts: [] },
      };
    }
    throw new Error(`unexpected path ${p}`);
  });
}

describe("/pathfinder landing (server client)", () => {
  it("asks who can introduce you and suggests warm intros", async () => {
    serveGraph();
    const html = await render({});
    expect(html).toContain("Pathfinder");
    expect(html).toContain("Who can introduce you");
    expect(html).toContain("Who do you want to reach?");
    expect(html).toContain("Suggested introductions");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("3 linked contacts");
  });

  it("explains itself when the server reports no graph", async () => {
    serveGraph();
    serverFetchJson.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/graph/path")) {
        throw new Error("unexpected");
      }
      if (p.startsWith("/api/graph")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: { nodes: 0, edges: 0, warmIntros: [] },
        };
      }
      if (p.startsWith("/api/search")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: { contacts: [] },
        };
      }
      throw new Error(`unexpected path ${p}`);
    });
    const html = await render({});
    expect(html).toContain("needs a graph to walk");
  });

  it("shows a banner when the server is unreachable", async () => {
    serverFetchJson.mockRejectedValue(new Error("ECONNREFUSED"));
    const html = await render({});
    expect(html).toContain("Server not reachable");
    expect(html).toContain("netpro serve");
  });
});

describe("/pathfinder results (server client)", () => {
  it("shows the plan's five facts for every ranked chain", async () => {
    serveGraph();
    const html = await render({ target: "c", from: "a" });
    expect(html).toContain("Paths to Cara Chen");
    expect(html).toContain("Path strength");
    expect(html).toContain("Weakest relationship");
    expect(html).toContain("Average relationship");
    expect(html).toContain("Hops");
    expect(html).toContain("Intermediaries");
    // The intermediary is named, the chain is vertical, the ask is explicit.
    expect(html).toContain("Bob Builder");
    expect(html).toContain("· intermediary");
    expect(html).toContain("First ask:");
    expect(html).toContain("Ask Ada Lovelace to connect you with Bob Builder.");
    expect(html).not.toContain("(local fallback)");
    const pathCall = serverFetchJson.mock.calls.find((call) =>
      String(call[0]).startsWith("/api/graph/path"),
    );
    expect(pathCall).toBeDefined();
    expect(String(pathCall![0])).toContain("target=c");
    expect(String(pathCall![0])).toContain("from=a");
  });

  it("renders a server 4xx as an answer instead of falling back", async () => {
    serverFetchJson.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/graph/path")) {
        return {
          ok: false,
          status: 404,
          serverUrl: "http://127.0.0.1:3777",
          data: { error: 'Target: no contact "nobody".', code: "not_found" },
        };
      }
      if (p.startsWith("/api/search")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: { contacts: [] },
        };
      }
      throw new Error(`unexpected path ${p}`);
    });
    const html = await render({ target: "nobody" });
    expect(html).toContain("Target:");
    expect(html).not.toContain("(local fallback)");
  });

  it("shows a banner when the server is unreachable mid-query", async () => {
    serverFetchJson.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/graph/path")) {
        throw new Error("ECONNREFUSED");
      }
      if (p.startsWith("/api/search")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: { contacts: [] },
        };
      }
      throw new Error(`unexpected path ${p}`);
    });
    const html = await render({ target: "c", from: "a" });
    expect(html).toContain("Server not reachable");
    expect(html).toContain("netpro serve");
  });
});
