vi.mock("@/lib/authz", () => ({
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
// The page prefers the standalone server; tests pin the fallback by refusing
// the server by default, then opt into the server path per test.
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

import PathfinderPage from "./page";

const NOW = new Date("2026-09-07T12:00:00Z").toISOString();

async function render(params: Record<string, string> = {}): Promise<string> {
  const element = await PathfinderPage({
    searchParams: Promise.resolve(params),
  });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

beforeEach(() => {
  serverFetchJson.mockReset();
  serverFetchJson.mockRejectedValue(new Error("server down"));
  fixture.sqlite.exec("DELETE FROM edges; DELETE FROM contacts;");
  for (const row of [
    { id: "a", fullName: "Ada Lovelace", relationshipScore: 0.9 },
    { id: "b", fullName: "Bob Builder", relationshipScore: 0.8 },
    { id: "c", fullName: "Cara Chen", relationshipScore: 0.7 },
    { id: "d", fullName: "Dan Delta", relationshipScore: 0.1 },
  ]) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ ...row, source: "test", createdAt: NOW, updatedAt: NOW })
      .run();
  }
  // Chain a—b—c; d stays isolated for the unreachable case.
  let n = 0;
  for (const [s, t] of [["a", "b"], ["b", "c"]] as const) {
    fixture.conn.db
      .insert(fixture.conn.schema.edges)
      .values({
        id: `e${++n}`,
        sourceId: s,
        targetId: t,
        relation: "colleague",
        strength: 0.8,
        confidence: 1,
        bidirectional: true,
        source: "manual",
        status: "confirmed",
        discoveredAt: NOW,
        updatedAt: NOW,
      })
      .run();
  }
});
afterAll(() => fixture.sqlite.close());

describe("/pathfinder landing", () => {
  it("asks who can introduce you and suggests warm intros", async () => {
    const html = await render({});
    expect(html).toContain("Pathfinder");
    expect(html).toContain("Who can introduce you");
    expect(html).toContain("Who do you want to reach?");
    expect(html).toContain("Suggested introductions");
    expect(html).toContain("Ada Lovelace");
  });

  it("explains itself when the graph is empty", async () => {
    fixture.sqlite.exec("DELETE FROM edges;");
    const html = await render({});
    expect(html).toContain("needs a graph to walk");
  });
});

describe("/pathfinder results (local fallback)", () => {
  it("shows the plan's five facts for every ranked chain", async () => {
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
    expect(html).toContain("Draft intro request to");
    expect(html).toContain("(local fallback)");
  });

  it("defaults the origin to the strongest tie and says so", async () => {
    const html = await render({ target: "c" });
    expect(html).toContain("Paths to Cara Chen");
    expect(html).toContain("your strongest tie");
  });

  it("says so when nothing connects within depth", async () => {
    const html = await render({ target: "d", from: "a" });
    expect(html).toContain("No path to Dan Delta");
    expect(html).toContain("add a link or review pending candidates");
  });

  it("renders unknown selectors as an error, not a crash", async () => {
    const html = await render({ target: "nobody-here" });
    expect(html).toContain("Target:");
  });
});

describe("/pathfinder results (server path)", () => {
  const plan = {
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
            via: {
              relations: ["colleague"],
              minConfidence: 1,
              minStrength: 0.8,
              oneWay: false,
            },
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

  function servePlan() {
    serverFetchJson.mockImplementation(async (path: string) => {
      if (String(path).startsWith("/api/graph/path")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: plan,
        };
      }
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: { contacts: [] },
      };
    });
  }

  it("renders server-ranked chains without touching local core", async () => {
    servePlan();
    const html = await render({ target: "c", from: "a" });
    expect(html).toContain("Paths to Cara Chen");
    expect(html).toContain("Path strength");
    expect(html).toContain("Bob Builder");
    expect(html).toContain(
      "Ask Ada Lovelace to connect you with Bob Builder.",
    );
    expect(html).toContain("Draft intro request to Ada Lovelace");
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
      if (String(path).startsWith("/api/graph/path")) {
        return {
          ok: false,
          status: 404,
          serverUrl: "http://127.0.0.1:3777",
          data: { error: 'Target: no contact "nobody".', code: "not_found" },
        };
      }
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: { contacts: [] },
      };
    });
    const html = await render({ target: "nobody" });
    expect(html).toContain("Target:");
    expect(html).not.toContain("(local fallback)");
  });
});
