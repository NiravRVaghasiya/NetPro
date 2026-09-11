import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = await vi.hoisted(async () => {
  const { createTestSqliteConn } = await import("@netpro/db/src/testing");
  return createTestSqliteConn();
});
vi.mock("@/lib/authz", () => ({
  requireScope: async () => ({
    workspaceId: "default",
    role: "owner",
    userId: "system",
  }),
}));
vi.mock("@/lib/db", () => ({ conn: fixture.conn }));

import { GET, POST } from "./route";
import { GET as GetById, PATCH } from "./[id]/route";
import { POST as MarkRecipient } from "./[id]/recipients/[recipientId]/route";

const NOW_ISO = new Date().toISOString();

function seedContact(id: string, fullName: string, company = "Stripe") {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id,
      fullName,
      email: `${id}@example.com`,
      company,
      role: "Engineer",
      source: "test",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    })
    .run();
}

beforeEach(() => {
  fixture.sqlite.exec(
    "DELETE FROM activity_log; DELETE FROM interactions; DELETE FROM campaign_recipients; DELETE FROM campaigns; DELETE FROM follow_ups; DELETE FROM contacts;",
  );
  seedContact("c1", "Jane Doe", "Stripe");
  seedContact("c2", "John Smith", "Acme");
});
afterAll(() => fixture.sqlite.close());

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function patch(url: string, body: unknown): Request {
  return new Request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const template = {
  subject: "Hi {{firstName}}",
  body: "Loved your work at {{company}}.",
};

describe("POST /api/campaigns", () => {
  it("creates a draft and snapshots recipients (201)", async () => {
    const res = await POST(
      post("http://localhost/api/campaigns", {
        name: "Reactivation",
        template,
        recipients: { contactIds: ["c1", "c2"] },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      campaign: {
        id: string;
        status: string;
        type: string;
        totalRecipients: number;
      };
      added: number;
    };
    expect(body.campaign.status).toBe("draft");
    expect(body.campaign.type).toBe("single");
    expect(body.added).toBe(2);
    expect(body.campaign.totalRecipients).toBe(2);
  });

  it("maps validation errors to 400 with a code", async () => {
    const res = await POST(
      post("http://localhost/api/campaigns", { name: "", template }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_input");
  });

  it("rejects a non-JSON body with 415", async () => {
    const res = await POST(
      new Request("http://localhost/api/campaigns", {
        method: "POST",
        body: "name=x",
      }),
    );
    expect(res.status).toBe(415);
  });

  it("rejects unknown recipient ids with 404", async () => {
    const res = await POST(
      post("http://localhost/api/campaigns", {
        name: "X",
        template,
        recipients: { contactIds: ["ghost"] },
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/campaigns", () => {
  it("lists campaigns and filters by status", async () => {
    await POST(post("http://localhost/api/campaigns", { name: "A", template }));
    const b = await POST(
      post("http://localhost/api/campaigns", { name: "B", template }),
    );
    const bId = ((await b.json()) as { campaign: { id: string } }).campaign.id;
    await PATCH(
      patch(`http://localhost/api/campaigns/${bId}`, {
        action: "status",
        status: "active",
      }),
      {
        params: Promise.resolve({ id: bId }),
      },
    );

    const all = await GET(new Request("http://localhost/api/campaigns"));
    expect(all.status).toBe(200);
    expect(((await all.json()) as { total: number }).total).toBe(2);

    const active = await GET(
      new Request("http://localhost/api/campaigns?status=active"),
    );
    const activeBody = (await active.json()) as {
      campaigns: { name: string }[];
    };
    expect(activeBody.campaigns.map((c) => c.name)).toEqual(["B"]);

    const bad = await GET(
      new Request("http://localhost/api/campaigns?status=launched"),
    );
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/campaigns/[id]", () => {
  it("renders recipients with personalized drafts", async () => {
    const created = await POST(
      post("http://localhost/api/campaigns", {
        name: "Render",
        template,
        recipients: { contactIds: ["c1"] },
      }),
    );
    const id = ((await created.json()) as { campaign: { id: string } }).campaign
      .id;

    const res = await GetById(
      new Request(`http://localhost/api/campaigns/${id}`),
      {
        params: Promise.resolve({ id }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      campaign: { name: string };
      recipients: {
        contactName: string;
        draft: { subject: string; body: string } | null;
      }[];
      dailyLimitRemaining: number;
    };
    expect(body.campaign.name).toBe("Render");
    expect(body.recipients[0]!.draft).toEqual({
      subject: "Hi Jane",
      body: "Loved your work at Stripe.",
    });
    expect(body.dailyLimitRemaining).toBe(50);
  });

  it("404s for unknown campaigns", async () => {
    const res = await GetById(
      new Request("http://localhost/api/campaigns/nope"),
      {
        params: Promise.resolve({ id: "nope" }),
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/campaigns/[id]", () => {
  async function makeDraft() {
    const created = await POST(
      post("http://localhost/api/campaigns", { name: "P", template }),
    );
    return ((await created.json()) as { campaign: { id: string } }).campaign.id;
  }

  it("walks the lifecycle via action=status", async () => {
    const id = await makeDraft();
    const activate = await PATCH(
      patch(`http://localhost/api/campaigns/${id}`, {
        action: "status",
        status: "active",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(activate.status).toBe(200);
    expect(((await activate.json()) as { status: string }).status).toBe(
      "active",
    );
  });

  it("rejects an illegal transition with 409", async () => {
    const id = await makeDraft();
    const res = await PATCH(
      patch(`http://localhost/api/campaigns/${id}`, {
        action: "status",
        status: "completed",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(409);
  });

  it("rejects an unknown status with 400", async () => {
    const id = await makeDraft();
    const res = await PATCH(
      patch(`http://localhost/api/campaigns/${id}`, {
        action: "status",
        status: "launched",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);
  });

  it("edits a draft via action=update and freezes once active", async () => {
    const id = await makeDraft();
    const updated = await PATCH(
      patch(`http://localhost/api/campaigns/${id}`, {
        action: "update",
        name: "Renamed",
        template: { subject: "Hello {{firstName}}", body: "b" },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { name: string }).name).toBe("Renamed");

    await PATCH(
      patch(`http://localhost/api/campaigns/${id}`, {
        action: "status",
        status: "active",
      }),
      {
        params: Promise.resolve({ id }),
      },
    );
    const frozen = await PATCH(
      patch(`http://localhost/api/campaigns/${id}`, {
        action: "update",
        name: "Nope",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(frozen.status).toBe(409);
  });

  it("adds recipients via action=add-recipients", async () => {
    const id = await makeDraft();
    const res = await PATCH(
      patch(`http://localhost/api/campaigns/${id}`, {
        action: "add-recipients",
        recipients: { search: { company: "Stripe" } },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { added: number }).added).toBe(1);
  });

  it("rejects an unknown action with 400", async () => {
    const id = await makeDraft();
    const res = await PATCH(
      patch(`http://localhost/api/campaigns/${id}`, { action: "launch" }),
      {
        params: Promise.resolve({ id }),
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/campaigns/[id]/recipients/[recipientId]", () => {
  async function activeCampaignWith(
    recipientContactIds: string[],
    opts: { dailyLimit?: number; steps?: unknown[] } = {},
  ) {
    const created = await POST(
      post("http://localhost/api/campaigns", {
        name: "M",
        template,
        steps: opts.steps,
        dailyLimit: opts.dailyLimit,
        recipients: { contactIds: recipientContactIds },
      }),
    );
    const id = ((await created.json()) as { campaign: { id: string } }).campaign
      .id;
    await PATCH(
      patch(`http://localhost/api/campaigns/${id}`, {
        action: "status",
        status: "active",
      }),
      {
        params: Promise.resolve({ id }),
      },
    );
    const render = await GetById(
      new Request(`http://localhost/api/campaigns/${id}`),
      {
        params: Promise.resolve({ id }),
      },
    );
    const recipients = (
      (await render.json()) as {
        recipients: { id: string; contactId: string }[];
      }
    ).recipients;
    return { id, recipients };
  }

  function mark(id: string, recipientId: string, body: unknown) {
    return MarkRecipient(
      post(
        `http://localhost/api/campaigns/${id}/recipients/${recipientId}`,
        body,
      ),
      { params: Promise.resolve({ id, recipientId }) },
    );
  }

  it("marks sent: logs an interaction and returns the updated recipient", async () => {
    const { id, recipients } = await activeCampaignWith(["c1"]);
    const recipientId = recipients.find((r) => r.contactId === "c1")!.id;
    const res = await mark(id, recipientId, { action: "sent" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recipient: { status: string };
      interactionId: string;
      campaign: { sent: number };
    };
    expect(body.recipient.status).toBe("sent");
    expect(body.campaign.sent).toBe(1);
    expect(body.interactionId).toBeTruthy();

    const interaction = fixture.sqlite
      .prepare("SELECT type, subject FROM interactions WHERE contact_id = 'c1'")
      .get() as { type: string; subject: string };
    expect(interaction).toMatchObject({
      type: "email_sent",
      subject: "Hi Jane",
    });
  });

  it("requires an active campaign (409 on a draft)", async () => {
    const created = await POST(
      post("http://localhost/api/campaigns", {
        name: "D",
        template,
        recipients: { contactIds: ["c1"] },
      }),
    );
    const id = ((await created.json()) as { campaign: { id: string } }).campaign
      .id;
    const render = await GetById(
      new Request(`http://localhost/api/campaigns/${id}`),
      {
        params: Promise.resolve({ id }),
      },
    );
    const recipientId = (
      (await render.json()) as { recipients: { id: string }[] }
    ).recipients[0]!.id;
    const res = await mark(id, recipientId, { action: "sent" });
    expect(res.status).toBe(409);
  });

  it("enforces the daily limit (409) and honors force", async () => {
    const { id, recipients } = await activeCampaignWith(["c1", "c2"], {
      dailyLimit: 1,
    });
    const r1 = recipients.find((r) => r.contactId === "c1")!.id;
    const r2 = recipients.find((r) => r.contactId === "c2")!.id;
    await mark(id, r1, { action: "sent" });
    const blocked = await mark(id, r2, { action: "sent" });
    expect(blocked.status).toBe(409);
    const forced = await mark(id, r2, { action: "sent", force: true });
    expect(forced.status).toBe(200);
  });

  it("schedules the next drip step for a sequence", async () => {
    const { id, recipients } = await activeCampaignWith(["c1"], {
      steps: [
        { delayDays: 3, subject: "Bump", body: "Still there, {{firstName}}?" },
      ],
    });
    const recipientId = recipients.find((r) => r.contactId === "c1")!.id;
    const res = await mark(id, recipientId, { action: "sent" });
    const body = (await res.json()) as {
      recipient: {
        status: string;
        scheduledAt: string | null;
        draft: { subject: string } | null;
      };
    };
    expect(body.recipient.status).toBe("scheduled");
    expect(body.recipient.scheduledAt).toBeTruthy();
    expect(body.recipient.draft?.subject).toBe("Bump");
  });

  it("records a reply and cancels the drip", async () => {
    const { id, recipients } = await activeCampaignWith(["c1"]);
    const recipientId = recipients.find((r) => r.contactId === "c1")!.id;
    await mark(id, recipientId, { action: "sent" });
    const res = await mark(id, recipientId, { action: "replied" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recipient: { status: string };
      campaign: { replied: number };
    };
    expect(body.recipient.status).toBe("replied");
    expect(body.campaign.replied).toBe(1);
    const inbound = fixture.sqlite
      .prepare(
        "SELECT type, direction FROM interactions WHERE type = 'email_received'",
      )
      .get() as { type: string; direction: string };
    expect(inbound).toMatchObject({
      type: "email_received",
      direction: "inbound",
    });
  });

  it("skips without logging an interaction", async () => {
    const { id, recipients } = await activeCampaignWith(["c1"]);
    const recipientId = recipients.find((r) => r.contactId === "c1")!.id;
    const res = await mark(id, recipientId, { action: "skipped" });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { recipient: { status: string } }).recipient
        .status,
    ).toBe("skipped");
    const n = fixture.sqlite
      .prepare("SELECT count(*) AS n FROM interactions")
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("rejects an unknown action with 400", async () => {
    const { id, recipients } = await activeCampaignWith(["c1"]);
    const res = await mark(id, recipients[0]!.id, { action: "opened" });
    expect(res.status).toBe(400);
  });
});
