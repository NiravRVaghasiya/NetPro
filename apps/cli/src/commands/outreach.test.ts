import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@netpro/db/src/schema.sqlite";
import type { SqliteConn } from "@netpro/db";

// The keychain touches ~/.netpro with scrypt; stub it so tests stay hermetic.
vi.mock("../../src/config/keychain", () => ({
  Keychain: {
    get: vi.fn(async (key: string) =>
      key === "user.name" ? "Alex Keychain" : null,
    ),
  },
}));

import { toOutreachInput, executeOutreach } from "./outreach";

function createTestConn(): SqliteConn {
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
  return { dialect: "sqlite", db, schema };
}

async function seed(conn: SqliteConn): Promise<void> {
  const now = new Date().toISOString();
  await conn.db.insert(conn.schema.contacts).values([
    {
      id: "c1",
      fullName: "Jane Doe",
      email: "jane@stripe.com",
      company: "Stripe",
      role: "Senior Engineer",
      source: "test",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "c2",
      fullName: "John Smith",
      email: "john@acme.com",
      company: "Acme",
      role: "Designer",
      source: "test",
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

function stubOpenAiFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
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
                  body: "Loved your work at Stripe.",
                }),
              },
            },
          ],
        }),
      }) as Response,
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("toOutreachInput", () => {
  it("maps a --to selector with tone defaults", () => {
    const input = toOutreachInput({ to: "jane@stripe.com" });
    expect(input.selector).toBe("jane@stripe.com");
    expect(input.adHoc).toBeUndefined();
    expect(input.compose.tone).toBe("professional");
  });

  it("maps ad-hoc recipient flags", () => {
    const input = toOutreachInput({
      name: "Pat Lee",
      email: "pat@x.com",
      company: "X",
      tone: "warm",
    });
    expect(input.selector).toBeUndefined();
    expect(input.adHoc).toEqual({
      name: "Pat Lee",
      email: "pat@x.com",
      company: "X",
      role: undefined,
    });
    expect(input.compose.tone).toBe("warm");
  });

  it("rejects an unknown tone", () => {
    expect(() => toOutreachInput({ to: "x@y.com", tone: "shouty" })).toThrow(
      /Unknown --tone/,
    );
  });

  it("rejects mixing --to with ad-hoc recipient flags", () => {
    expect(() => toOutreachInput({ to: "x@y.com", name: "Pat" })).toThrow(
      /cannot be combined/,
    );
  });

  it("requires any recipient at all", () => {
    expect(() => toOutreachInput({ context: "hi" })).toThrow(
      /Provide a recipient/,
    );
  });
});

describe("executeOutreach", () => {
  let conn: SqliteConn;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    conn = createTestConn();
    await seed(conn);
    fetchMock = stubOpenAiFetch();
    process.env.OPENAI_API_KEY = "sk-test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it("drafts a message to a stored contact, personalizing from their record", async () => {
    const output = await executeOutreach(
      { to: "jane@stripe.com", context: "React Conf", purpose: "a quick chat" },
      conn,
    );

    expect(output).toContain("Subject: Hi Jane");
    expect(output).toContain("Loved your work at Stripe.");

    // The contact facts reached the prompt.
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    const userMessage = body.messages.find(
      (m: { role: string }) => m.role === "user",
    ).content;
    expect(userMessage).toContain("Jane Doe");
    expect(userMessage).toContain("Stripe");
    expect(userMessage).toContain("React Conf");
  });

  it("drafts for an ad-hoc recipient and emits JSON when asked", async () => {
    const output = await executeOutreach(
      { name: "Pat Lee", email: "pat@newco.com", company: "NewCo", json: true },
      conn,
    );
    const draft = JSON.parse(output);
    expect(draft).toMatchObject({
      subject: "Hi Jane",
      body: "Loved your work at Stripe.",
      provider: "openai",
      tone: "professional",
    });
    expect(typeof draft.generatedAt).toBe("string");
  });

  it("fails clearly when no AI key is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      executeOutreach({ to: "jane@stripe.com" }, conn),
    ).rejects.toThrow(/ai\.openai\.key/);
  });

  it("surfaces contact resolution errors (unknown / ambiguous)", async () => {
    await expect(
      executeOutreach({ to: "nobody@nowhere.com" }, conn),
    ).rejects.toThrow(/No contact matches/);
  });
});
