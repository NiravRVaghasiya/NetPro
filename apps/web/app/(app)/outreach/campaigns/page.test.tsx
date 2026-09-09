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
// The create panel is a client component (useRouter); stub it so the server
// render stays static — its behavior is covered by the API tests.
vi.mock("./panels", () => ({
  CampaignCreatePanel: () => <div data-testid="create-panel" />,
}));

import CampaignsPage from "./page";
import { createCampaign, setCampaignStatus } from "@netpro/core/src/campaigns";

const NOW = new Date("2026-09-06T12:00:00Z");
const template = { subject: "Hi {{firstName}}", body: "Loved your work." };

async function render(
  searchParams: Record<string, string> = {},
): Promise<string> {
  const element = await CampaignsPage({
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

beforeEach(() => {
  fixture.sqlite.exec(
    "DELETE FROM activity_log; DELETE FROM interactions; DELETE FROM campaign_recipients; DELETE FROM campaigns; DELETE FROM contacts;",
  );
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id: "c1",
      fullName: "Jane Doe",
      company: "Stripe",
      source: "test",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
});
afterAll(() => fixture.sqlite.close());

describe("/outreach/campaigns list page", () => {
  it("renders the empty state and the create panel", async () => {
    const html = await render();
    expect(html).toContain("Campaigns");
    expect(html).toContain("No campaigns yet");
    expect(html).toContain("create-panel");
  });

  it("lists campaigns with status, type, and counts", async () => {
    const draft = await createCampaign(
      fixture.conn,
      { name: "Reactivation", template, recipients: { contactIds: ["c1"] } },
      { now: NOW },
    );
    await createCampaign(
      fixture.conn,
      { name: "Newsletter", template },
      { now: NOW },
    );
    await setCampaignStatus(fixture.conn, draft.campaign.id, "active", {
      now: NOW,
    });

    const html = await render();
    expect(html).toContain("Reactivation");
    expect(html).toContain("Newsletter");
    expect(html).toContain("active");
    expect(html).toContain("draft");
    // the single recipient shows up as a count in the table
    expect(html).toMatch(/<td>1<\/td>/);
  });

  it("filters by status from the query string", async () => {
    const draft = await createCampaign(
      fixture.conn,
      { name: "Reactivation", template },
      { now: NOW },
    );
    await createCampaign(
      fixture.conn,
      { name: "Newsletter", template },
      { now: NOW },
    );
    await setCampaignStatus(fixture.conn, draft.campaign.id, "active", {
      now: NOW,
    });

    const activeOnly = await render({ status: "active" });
    expect(activeOnly).toContain("Reactivation");
    expect(activeOnly).not.toContain("Newsletter");
  });
});
