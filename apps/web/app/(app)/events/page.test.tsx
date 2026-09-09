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
// The panels are client components (useRouter); stub them so the server render
// stays static — their APIs are covered by the route tests.
vi.mock("./panels", () => ({
  AddEventForm: () => <div data-testid="add-event-form" />,
  ImportEventsPanel: () => <div data-testid="import-panel" />,
}));

import EventsPage from "./page";

const NOW = new Date("2026-09-07T12:00:00.000Z").toISOString();

async function render(params: Record<string, string> = {}): Promise<string> {
  const element = await EventsPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

/** The list alone — recommendations link to the same events, so tests that
 *  assert on filtering have to look at the table. */
function tableOf(html: string): string {
  return (
    html.match(/<table[^>]*data-testid="events-table"[\s\S]*?<\/table>/)?.[0] ??
    ""
  );
}

async function seed(): Promise<void> {
  fixture.sqlite.exec(
    "DELETE FROM event_attendees; DELETE FROM events; DELETE FROM edges; DELETE FROM activity_log; DELETE FROM contacts;",
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
    {
      id: "gone",
      fullName: "Ghost",
      email: "ghost@example.com",
      deletedAt: NOW,
    },
  ]) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ ...r, source: "test", createdAt: NOW, updatedAt: NOW })
      .run();
  }
  const { importEvents } = await import("@netpro/core/src/events");
  await importEvents(fixture.conn, {
    csv: [
      "name,location,starts_at,attendees",
      'React Conf,Berlin,2026-09-14,"ada@engines.dev; bob@builders.io"',
      "Old RustConf,Portland,2020-03-01,ada@engines.dev",
      "Empty Meetup,,2026-10-01,",
    ].join("\n"),
    now: new Date(NOW),
  });
}

beforeEach(async () => {
  await seed();
});
afterAll(() => fixture.sqlite.close());

describe("/events page", () => {
  it("renders the list, the counts and the panels", async () => {
    const html = await render();
    expect(html).toContain("<h1>Events</h1>");
    expect(html).toContain(
      "3 events · 3 attendance rows · 2 of 2 contacts have been somewhere",
    );
    expect(html).toContain("React Conf");
    expect(html).toContain("Berlin");
    expect(html).toContain("add-event-form");
    expect(html).toContain("import-panel");
    expect(html).not.toContain("Ghost");
  });

  it("links each event to its detail page and shows network overlap", async () => {
    const html = await render();
    const id = fixture.sqlite
      .prepare("SELECT id FROM events WHERE name = 'React Conf'")
      .get() as { id: string };
    expect(html).toContain(`href="/events/${id.id}"`);
    expect(html).toContain("<strong>2</strong>");
    expect(html).toContain("nobody yet");
  });

  it("renders recommendations with their reasons", async () => {
    const html = await render();
    expect(html).toContain("Where to go next");
    expect(html).toContain("2 people in your network");
    expect(html).toContain("industries (fintech) cover 100% of your network");
    // Timing reason is date-dependent (2026-09-14 is 7d from NOW=2026-09-07 but 6d from real now 2026-09-08).
    // Assert pattern, not exact count, to avoid flakiness.
    expect(html).toMatch(/starts in \d+ days?/);
    // An empty *upcoming* event is still a suggestion; an empty past one is not.
    expect(html).toContain("nobody from your network yet");
    expect(html).toContain("1 person in your network");
  });

  it("keeps the filter values and filters the list by name", async () => {
    const filtered = await render({ query: "rust", upcoming: "true" });
    expect(filtered).toContain('value="rust"');
    expect(filtered).toContain('checked=""');
    // Old RustConf is in the past, so "rust + upcoming" is empty.
    expect(tableOf(filtered)).toBe("");
    expect(filtered).toContain("No events yet. Add one below");

    const byName = await render({ query: "react" });
    expect(tableOf(byName)).toContain("React Conf");
    expect(tableOf(byName)).not.toContain("RustConf");
    // Recommendations are global, not filtered.
    expect(byName).toContain("Where to go next");
  });

  it("has an empty state", async () => {
    fixture.sqlite.exec("DELETE FROM event_attendees; DELETE FROM events;");
    const html = await render();
    expect(html).toContain("No events yet");
    expect(html).toContain("0 events · 0 attendance rows");
  });
});
