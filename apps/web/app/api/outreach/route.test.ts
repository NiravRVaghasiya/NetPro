import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@netpro/db/src/schema.sqlite";

// In-memory SQLite seeded with one contact, mirroring the analytics route
// test harness.
vi.mock("@/lib/db", () => {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL, first_name TEXT, last_name TEXT,
      email TEXT, email_verified INTEGER DEFAULT 0, phone TEXT, avatar_url TEXT,
      headline TEXT, company TEXT, company_domain TEXT, role TEXT, seniority TEXT,
      department TEXT, industry TEXT, location TEXT, country TEXT, timezone TEXT,
      linkedin_url TEXT, github_url TEXT, twitter_url TEXT, website_url TEXT,
      source TEXT NOT NULL, source_id TEXT, tags TEXT, custom_fields TEXT, notes TEXT, skills TEXT,
      relationship_score REAL DEFAULT 0, last_interaction TEXT, interaction_count INTEGER DEFAULT 0,
      workspace_id TEXT DEFAULT 'default', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
  `);
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO contacts (id, full_name, email, company, role, created_at, updated_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'test')`,
    )
    .run(
      "c1",
      "Jane Doe",
      "jane@stripe.com",
      "Stripe",
      "Senior Engineer",
      now,
      now,
    );
  return { conn: { dialect: "sqlite", db, schema } };
});

// The provider never makes a network call in tests: fetch is stubbed to
// return a fixed valid completion.
vi.stubGlobal(
  "fetch",
  vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  subject: "Hi Jane",
                  body: "Saw your work at Stripe.",
                }),
              },
            },
          ],
        }),
      }) as Response,
  ),
);

import { POST } from "./route";

async function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/outreach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/outreach", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("drafts for a stored contact and returns the draft shape", async () => {
    const res = await post({
      contactId: "c1",
      tone: "warm",
      context: "React Conf",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subject: string;
      body: string;
      provider: string;
      tone: string;
      generatedAt: string;
    };
    expect(body.subject).toBe("Hi Jane");
    expect(body.body).toContain("Stripe");
    expect(body.provider).toBe("openai");
    expect(body.tone).toBe("warm");
    expect(typeof body.generatedAt).toBe("string");
  });

  it("drafts for an ad-hoc recipient", async () => {
    const res = await post({
      recipient: { name: "Pat", email: "pat@x.com", company: "NewCo" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subject: string };
    expect(body.subject).toBe("Hi Jane");
  });

  it("400s on non-JSON bodies", async () => {
    const res = await post("not json{");
    expect(res.status).toBe(400);
  });

  it("400s when neither contactId nor recipient is given", async () => {
    const res = await post({ context: "hi" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/contactId|recipient/);
  });

  it("400s on an invalid tone", async () => {
    const res = await post({ contactId: "c1", tone: "shouty" });
    expect(res.status).toBe(400);
  });

  it("400s on an unknown contact id", async () => {
    const res = await post({ contactId: "nope" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No contact found/);
  });

  it("400s when the ad-hoc recipient has neither name nor email", async () => {
    const res = await post({ recipient: { company: "Acme" } });
    expect(res.status).toBe(400);
  });

  it("400s on invalid input (bad email shape, oversize context)", async () => {
    const badEmail = await post({ recipient: { email: "not-an-email" } });
    expect(badEmail.status).toBe(400);
    const tooLong = await post({
      recipient: { name: "Pat" },
      context: "x".repeat(2001),
    });
    expect(tooLong.status).toBe(400);
  });

  it("returns ai_not_configured (500) when no server key is set", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_PROVIDER;
    const res = await post({ contactId: "c1" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("ai_not_configured");
  });

  it("returns ai_upstream_error (502) when the provider call fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce(
      async () =>
        ({
          ok: false,
          status: 429,
          json: async () => ({ error: { message: "rate limited" } }),
        }) as Response,
    );
    const res = await post({ contactId: "c1" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("ai_upstream_error");
  });
});
