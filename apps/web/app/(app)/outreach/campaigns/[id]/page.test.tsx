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
vi.mock("../panels", () => ({
  CampaignStatusActions: ({ status }: { status: string }) => (
    <div data-testid={`status-${status}`} />
  ),
  RecipientActions: ({ recipientId }: { recipientId: string }) => (
    <span data-testid={`recipient-${recipientId}`} />
  ),
}));

import CampaignDetailPage from "./page";
import { createCampaign, setCampaignStatus } from "@netpro/core/src/campaigns";

const NOW = new Date("2026-09-06T12:00:00Z");
const template = {
  subject: "Hi {{firstName}}",
  body: "Loved your work at {{company}}.",
};

async function render(id: string): Promise<string> {
  const element = await CampaignDetailPage({ params: Promise.resolve({ id }) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

function seedContact(id: string, fullName: string, company: string) {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id,
      fullName,
      email: `${id}@example.com`,
      company,
      role: "Engineer",
      source: "test",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
}

beforeEach(() => {
  fixture.sqlite.exec(
    "DELETE FROM activity_log; DELETE FROM interactions; DELETE FROM campaign_recipients; DELETE FROM campaigns; DELETE FROM contacts;",
  );
  seedContact("c1", "Jane Doe", "Stripe");
  seedContact("c2", "John Smith", "Vercel");
});
afterAll(() => fixture.sqlite.close());

describe("/outreach/campaigns/[id] detail page", () => {
  it("renders the sequence, per-recipient drafts, and action stubs", async () => {
    const { campaign } = await createCampaign(
      fixture.conn,
      {
        name: "Reactivation",
        template,
        steps: [
          {
            delayDays: 3,
            subject: "Bump",
            body: "Still there, {{firstName}}?",
          },
        ],
        recipients: { contactIds: ["c1", "c2"] },
      },
      { now: NOW },
    );
    await setCampaignStatus(fixture.conn, campaign.id, "active", { now: NOW });

    const html = await render(campaign.id);
    expect(html).toContain("Reactivation");
    expect(html).toContain("2-message sequence");
    expect(html).toContain("Hi {{firstName}}"); // raw sequence template
    expect(html).toContain("Bump");
    // personalized drafts per recipient
    expect(html).toContain("Hi Jane");
    expect(html).toContain("Loved your work at Stripe.");
    expect(html).toContain("Hi John");
    expect(html).toContain("Loved your work at Vercel.");
    // status + recipient action stubs
    expect(html).toContain("status-active");
    expect(html).toContain("recipient-");
    // daily-limit meter shows for an active campaign
    expect(html).toContain("remaining under the daily limit");
  });

  it("404s for unknown campaigns", async () => {
    await expect(render("missing")).rejects.toThrow("NOT_FOUND");
  });

  it("shows the empty-recipient guidance when none were added", async () => {
    const { campaign } = await createCampaign(
      fixture.conn,
      { name: "Empty", template },
      { now: NOW },
    );
    const html = await render(campaign.id);
    expect(html).toContain("Empty");
    expect(html).toContain("No recipients yet");
    expect(html).toContain("status-draft");
  });
});
