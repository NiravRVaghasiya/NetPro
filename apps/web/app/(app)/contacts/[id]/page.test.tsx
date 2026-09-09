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
// The mutation panels are client components (useRouter); stub them so the
// server render stays static — their behavior is covered by the API tests.
vi.mock("./panels", () => ({
  LogInteractionPanel: () => <div data-testid="log-panel" />,
  AddFollowUpPanel: () => <div data-testid="followup-panel" />,
  FollowUpActions: ({ followUpId }: { followUpId: string }) => (
    <span data-testid={`actions-${followUpId}`} />
  ),
}));
vi.mock("../../edges/panels", () => ({
  MetAtEventPanel: () => <div data-testid="met-at-panel" />,
}));

import ContactDetailPage from "./page";

const NOW = new Date("2026-09-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

async function render(id: string): Promise<string> {
  const element = await ContactDetailPage({ params: Promise.resolve({ id }) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

beforeEach(() => {
  fixture.sqlite.exec(
    "DELETE FROM content_mentions; DELETE FROM content_metrics; DELETE FROM content_items; DELETE FROM follow_ups; DELETE FROM interactions; DELETE FROM enrichments; DELETE FROM contacts;",
  );
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id: "c1",
      fullName: "Jane Doe",
      headline: "Building payments at Stripe",
      company: "Stripe",
      role: "Engineer",
      location: "Berlin",
      email: "jane@stripe.com",
      linkedinUrl: "https://linkedin.com/in/jane",
      notes: "Met at React Conf.",
      skills: ["react", "rust"],
      source: "test",
      relationshipScore: 0.62,
      interactionCount: 1,
      lastInteraction: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
  fixture.conn.db
    .insert(fixture.conn.schema.interactions)
    .values({
      id: "i1",
      contactId: "c1",
      type: "meeting",
      direction: "outbound",
      channel: "in_person",
      content: "Coffee + collab talk",
      occurredAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
    })
    .run();
  fixture.conn.db
    .insert(fixture.conn.schema.followUps)
    .values({
      id: "f1",
      contactId: "c1",
      reason: "Send the deck",
      dueAt: new Date(NOW.getTime() + 3 * DAY).toISOString(),
      status: "pending",
      recurring: true,
      recurrenceRule: "30d",
      createdAt: NOW.toISOString(),
    })
    .run();
});
afterAll(() => fixture.sqlite.close());

describe("/contacts/[id] detail page", () => {
  it("renders profile, stats, timeline, and follow-ups", async () => {
    // The page reads "now" at render time; seed dates are relative to a fixed
    // clock, so assert on stable content rather than relative labels.
    const html = await render("c1");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("Building payments at Stripe");
    expect(html).toContain("Engineer · Stripe · Berlin");
    expect(html).toContain("jane@stripe.com");
    expect(html).toContain("linkedin.com/in/jane");
    expect(html).toContain("0.62");
    expect(html).toContain("1 interaction");
    expect(html).toContain("meeting");
    expect(html).toContain("Coffee + collab talk");
    expect(html).toContain("Send the deck");
    expect(html).toContain("every 30d");
    expect(html).toContain("Met at React Conf.");
    expect(html).toContain("log-panel");
    expect(html).toContain("followup-panel");
    expect(html).toContain("actions-f1");
  });

  it("shows skill tags with evidence and flags stored skills the text no longer supports (v2.0 Phase 5)", async () => {
    const html = await render("c1");
    // `react` comes from the notes ("React Conf") and is stored; `rust` is stored only.
    expect(html).toContain('href="/skills?skills=react"');
    expect(html).toContain('href="/skills?skills=rust"');
    expect(html).toContain("rust ?");
    expect(html).toContain("notes: “Met at React Conf.”");
    expect(html).toContain("rust stored but not supported by the current text");
    expect(html).toContain("Why these skills?");
  });

  it("explains when nothing is recognised yet", async () => {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({
        id: "c2",
        fullName: "Blank Slate",
        source: "test",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
    const html = await render("c2");
    expect(html).toContain("No taxonomy skills recognised");
  });

  it("404s for unknown contacts", async () => {
    await expect(render("missing")).rejects.toThrow("NOT_FOUND");
  });

  it("lists the content a contact is part of, and shows the empty state otherwise (v2.5 Phase 5)", async () => {
    const { upsertContentItem, addContentMention } =
      await import("@netpro/core/src/content");
    const { item } = await upsertContentItem(
      fixture.conn,
      {
        url: "https://example.dev/blog/one",
        title: "The Jane Doe interview",
        platform: "blog",
        publishedAt: NOW.toISOString(),
      },
      { now: NOW },
    );
    await addContentMention(fixture.conn, {
      contentId: item.id,
      contactId: "c1",
      context: "interviewed",
    });
    const html = await render("c1");
    expect(html).toContain("Content (1)");
    expect(html).toContain("The Jane Doe interview");
    expect(html).toContain(`href="/content/${item.id}"`);
    expect(html).toContain("content tracker");
    expect(html).toContain("Blog");

    fixture.sqlite.exec(
      "DELETE FROM content_mentions; DELETE FROM content_items;",
    );
    const empty = await render("c1");
    expect(empty).toContain("No content links this person yet");
  });

  it("shows guidance when there is no history yet", async () => {
    fixture.sqlite.exec("DELETE FROM follow_ups; DELETE FROM interactions;");
    const html = await render("c1");
    expect(html).toContain("Nothing scheduled.");
    expect(html).toContain("No interactions yet");
  });
});
