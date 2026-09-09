import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));
vi.mock("@/lib/authz", () => ({
  requireScope: async () => ({
    workspaceId: "default",
    userId: "test-user",
    role: "owner",
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import GraphContactPage from "./page";

const NOW = new Date("2026-09-07T12:00:00Z");
const iso = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();

async function render(id: string): Promise<string> {
  const el = await GraphContactPage({
    params: Promise.resolve({ contactId: id }),
  });
  return renderToStaticMarkup(el as unknown as React.ReactElement);
}

beforeEach(async () => {
  fixture.sqlite.exec(
    "DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;",
  );
  await fixture.conn.db.insert(fixture.conn.schema.contacts).values([
    {
      id: "a",
      fullName: "Ada",
      company: "Acme",
      relationshipScore: 0.9,
      lastInteraction: iso(5),
      source: "test",
      createdAt: iso(300),
      updatedAt: NOW.toISOString(),
    },
    {
      id: "b",
      fullName: "Bob",
      company: "Acme",
      relationshipScore: 0.6,
      source: "test",
      createdAt: iso(300),
      updatedAt: NOW.toISOString(),
    },
    {
      id: "z",
      fullName: "Zoe",
      company: "Beta",
      relationshipScore: 0.2,
      source: "test",
      createdAt: iso(300),
      updatedAt: NOW.toISOString(),
    },
  ]);
  await fixture.conn.db.insert(fixture.conn.schema.edges).values([
    {
      id: "e1",
      sourceId: "a",
      targetId: "b",
      relation: "colleague",
      strength: 0.7,
      confidence: 1,
      status: "confirmed",
      bidirectional: true,
      source: "manual",
      discoveredAt: iso(9),
      updatedAt: iso(9),
    },
    {
      id: "e2",
      sourceId: "b",
      targetId: "z",
      relation: "met_at_event",
      strength: 0.5,
      confidence: 1,
      status: "confirmed",
      bidirectional: true,
      source: "manual",
      discoveredAt: iso(9),
      updatedAt: iso(9),
    },
    {
      id: "p1",
      sourceId: "b",
      targetId: "z",
      relation: "mutual_network",
      strength: 0.4,
      confidence: 0.5,
      status: "pending",
      bidirectional: true,
      source: "linkedin_csv",
      discoveredAt: iso(2),
      updatedAt: iso(2),
    },
  ]);
});
afterAll(() => fixture.sqlite.close());

describe("/graph/[contactId] page", () => {
  it("renders centrality + community for a hub", async () => {
    const html = await render("b");
    expect(html).toContain("Bob in your graph");
    expect(html).toContain("Degree");
    expect(html).toContain("rank #1");
    expect(html).toContain("Community");
    expect(html).toContain("acme"); // dominant company label
    expect(html).toContain("Betweenness");
    expect(html).toContain("Links (3)"); // two confirmed + one pending row (same pair counted as rows)
  });

  it("shows pending adjacency rows so this page is also a confirmation entry point", async () => {
    const html = await render("b");
    expect(html).toContain(">pending<");
  });

  it("renders the no-graph state for an isolated contact", async () => {
    fixture.sqlite.exec("DELETE FROM edges;");
    const html = await render("a");
    expect(html).toContain("No edges from or to this contact");
    expect(html).toContain("no confirmed edges include this contact");
  });

  it("404s unknown ids", async () => {
    await expect(render("ghost")).rejects.toThrow("NOT_FOUND");
  });

  it("links warm-intro candidates into the pathfinder form", async () => {
    const html = await render("b");
    expect(html).toContain("Warm-intro suggestions involving Bob");
    expect(html).toContain("/graph?target=");
  });
});
