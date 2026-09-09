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

import GraphPage from "./page";

const NOW = new Date("2026-09-07T12:00:00Z");
const iso = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();

async function render(sp: Record<string, string> = {}): Promise<string> {
  const el = await GraphPage({ searchParams: Promise.resolve(sp) });
  return renderToStaticMarkup(el as unknown as React.ReactElement);
}

beforeEach(async () => {
  fixture.sqlite.exec(
    "DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;",
  );
  await fixture.conn.db.insert(fixture.conn.schema.contacts).values([
    {
      id: "a",
      fullName: "Ada Lovelace",
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
      fullName: "Zoe Target",
      company: "Beta",
      role: "CTO",
      relationshipScore: 0.1,
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
  ]);
});
afterAll(() => fixture.sqlite.close());

describe("/graph page", () => {
  it("shows the overview with hubs + candidates when no target given", async () => {
    const html = await render();
    expect(html).toContain("Warm intros");
    expect(html).toContain("Your graph at a glance");
    expect(html).toContain("Hubs");
    expect(html).toContain('name="target"');
    // Bob bridges Ada↔Zoe, so a warm-intro candidate link is offered.
    expect(html).toContain("/graph?target=");
  });

  it("renders the ranked chain with a per-hop draft link", async () => {
    const html = await render({ target: "Zoe Target", from: "Ada Lovelace" });
    expect(html).toContain("Paths to Zoe Target");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Zoe Target");
    expect(html).toContain("weakest tie");
    expect(html).toContain("/outreach?contactId=");
    expect(html).toContain("Draft intro request");
  });

  it("defaults the origin to the strongest tie and says so", async () => {
    const html = await render({ target: "z" });
    expect(html).toContain("your strongest tie");
  });

  it("reports no path honestly when depth is too small", async () => {
    const html = await render({ target: "z", from: "a", depth: "1" });
    expect(html).toContain("No path to");
  });

  it("shows the empty state when nothing is confirmed", async () => {
    fixture.sqlite.exec("DELETE FROM edges;");
    const html = await render();
    expect(html).toContain("No confirmed edges yet");
    expect(html).toContain("/edges");
  });

  it("surfaces a selector error inline instead of throwing", async () => {
    const html = await render({ target: "does-not-exist" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("No contact matches");
  });

  it("includes a pending nudge in the empty state", async () => {
    fixture.sqlite.exec("DELETE FROM edges;");
    await fixture.conn.db.insert(fixture.conn.schema.edges).values({
      id: "p1",
      sourceId: "a",
      targetId: "z",
      relation: "mutual_network",
      strength: 0.3,
      confidence: 0.5,
      status: "pending",
      bidirectional: true,
      source: "linkedin_csv",
      discoveredAt: iso(2),
      updatedAt: iso(2),
    });
    const html = await render();
    expect(html).toContain("pending candidate");
    expect(html).toContain("status=pending");
  });
});
