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

import ContactsPage from "./page";

const NOW_ISO = new Date().toISOString();
const DAY = 24 * 60 * 60 * 1000;

async function render(params: Record<string, string> = {}): Promise<string> {
  const element = await ContactsPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

beforeEach(() => {
  fixture.sqlite.exec(
    "DELETE FROM follow_ups; DELETE FROM interactions; DELETE FROM contacts;",
  );
});
afterAll(() => fixture.sqlite.close());

function seedCrm() {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values([
      {
        id: "c1",
        fullName: "Jane Doe",
        company: "Stripe",
        role: "Engineer",
        source: "test",
        lastInteraction: new Date(Date.now() - DAY).toISOString(),
        interactionCount: 3,
        relationshipScore: 0.62,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
      {
        id: "c2",
        fullName: "John Smith",
        company: "Acme",
        source: "test",
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ])
    .run();
  fixture.conn.db
    .insert(fixture.conn.schema.followUps)
    .values({
      id: "f-overdue",
      contactId: "c1",
      reason: "Send the deck",
      dueAt: new Date(Date.now() - 2 * DAY).toISOString(),
      status: "pending",
      createdAt: NOW_ISO,
    })
    .run();
}

describe("/contacts CRM page", () => {
  it("shows the empty state pointing at import", async () => {
    const html = await render();
    expect(html).toContain("No contacts yet.");
    expect(html).toContain("/import");
  });

  it("renders the CRM table with stats, score, and follow-up columns", async () => {
    seedCrm();
    const html = await render();
    expect(html).toContain("Jane Doe");
    expect(html).toContain("John Smith");
    expect(html).toContain("0.62");
    expect(html).toContain("/contacts/c1"); // rows link to the detail page
    expect(html).toContain("Send the deck"); // needs-attention section
    expect(html).toContain("1 overdue");
  });

  it("sort links round-trip the active sort and pagination", async () => {
    seedCrm();
    const html = await render({ sort: "score" });
    expect(html).toContain("<strong>Relationship score</strong>");
    expect(html).toContain("/contacts?sort=name");
  });

  it("clamps a bogus offset to 0 instead of crashing", async () => {
    seedCrm();
    const html = await render({ offset: "banana" });
    expect(html).toContain("Jane Doe");
  });
});
