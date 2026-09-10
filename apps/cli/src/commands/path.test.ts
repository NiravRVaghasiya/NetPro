import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteConn } from "@netpro/db";
import { createTestSqliteConn } from "@netpro/db/src/testing";

// The keychain touches ~/.netpro with scrypt; stub it so tests stay hermetic.
vi.mock("../config/keychain", () => ({
  Keychain: { get: vi.fn(async (key: string) => (key === "user.name" ? "Nirav K." : null)) },
}));

import { executePath, executePathDetailed, toPlanInput } from "./path";
import { addEdge } from "@netpro/core/src/graph";

const NOW = new Date("2026-09-07T12:00:00Z");
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86400000).toISOString();

function createTestConn(): SqliteConn {
  return createTestSqliteConn().conn;
}

async function seed(conn: SqliteConn): Promise<void> {
  await conn.db.insert(conn.schema.contacts).values([
    { id: "a", fullName: "Ada Lovelace", email: "ada@engines.dev", company: "Engines", role: "Founder", relationshipScore: 0.9, lastInteraction: iso(5), source: "test", createdAt: iso(300), updatedAt: NOW.toISOString() },
    { id: "c", fullName: "Cara", relationshipScore: 0.8, lastInteraction: iso(40), source: "test", createdAt: iso(300), updatedAt: NOW.toISOString() },
    { id: "z", fullName: "Zoe Target", company: "Acme", role: "CTO", relationshipScore: 0.1, source: "test", createdAt: iso(300), updatedAt: NOW.toISOString() },
  ]);
  await addEdge(conn, { sourceId: "a", targetId: "c", relation: "colleague" }, { now: NOW });
  await addEdge(conn, { sourceId: "c", targetId: "z", relation: "met_at_event" }, { now: NOW });
}

describe("toPlanInput", () => {
  it("maps flags to plan input + graph options", () => {
    const { input, graphOpts } = toPlanInput(
      { from: " Ada ", maxDepth: "6", relation: "colleague", status: "all", alt: "3" },
      "zoe@acme.com"
    );
    expect(input).toEqual({ target: "zoe@acme.com", from: "Ada", k: 3 });
    expect(graphOpts).toEqual({ maxDepth: 6, relation: "colleague", status: "all" });
  });

  it("trims blanks out to undefined", () => {
    const { input } = toPlanInput({ from: "   " }, "Zoe");
    expect(input.from).toBeUndefined();
  });

  it.each([
    [{ maxDepth: "0" }, /--max-depth/],
    [{ maxDepth: "abc" }, /--max-depth/],
    [{ alt: "-1" }, /--alt/],
    [{ relation: "telepathy" }, /--relation/],
    [{ status: "guessed" }, /--status/],
  ])("rejects %j", (opts, pattern) => {
    expect(() => toPlanInput(opts, "Zoe")).toThrow(pattern as RegExp);
  });
});

describe("executePath", () => {
  let conn: SqliteConn;
  beforeEach(() => {
    conn = createTestConn();
  });

  it("renders the ranked chain, per-node meta and the ask", async () => {
    await seed(conn);
    const out = await executePath({}, "Zoe Target", conn);
    expect(out).toContain("Warm-intro to Zoe Target from Ada Lovelace (your strongest tie)");
    expect(out).toContain("#1 (2 hops) · score 0.68");
    // Phase 13 — the first-class path summary names the weakest tie and the
    // average hop strength beside the score.
    expect(out).toContain("weakest 0.80");
    expect(out).toContain("avg 0.50");
    expect(out).toContain("Ada Lovelace (score 0.90 · last 2026-09-02) → Cara (score 0.80 · last 2026-07-29) → Zoe Target (score 0.10)");
    expect(out).toContain("Ask Ada Lovelace");
    expect(out).toContain("--draft composes the ask email");
  });

  it("--json emits the full plan payload", async () => {
    await seed(conn);
    const body = JSON.parse(await executePath({ json: true }, "Zoe Target", conn)) as {
      plan: { origin: { selectedBy: string }; found: boolean; paths: unknown[] };
    };
    expect(body.plan.origin.selectedBy).toBe("strongest-tie");
    expect(body.plan.found).toBe(true);
    expect(body.plan.paths).toHaveLength(1);
  });

  it("says so when nothing connects within depth", async () => {
    await seed(conn);
    const out = await executePath({ maxDepth: "1" }, "Zoe Target", conn);
    expect(out).toContain("No path within 1 hop over the analyzed edges");
    expect(out).toContain("netpro edge add");
  });

  it("reports selector misses via the core message", async () => {
    await seed(conn);
    await expect(executePath({}, "Nobody", conn)).rejects.toThrow(/Target: No contact matches/);
  });

  it("--draft composes the ask with a stubbed provider (never the network)", async () => {
    await seed(conn);
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchStub = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify({ subject: "Quick favor?", body: "Hi Ada — could you intro me to Zoe?" }) } },
          ],
        }),
      }) as Response
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      const out = await executePath({ draft: true }, "Zoe Target", conn);
      expect(out).toContain("Draft ask for Ada Lovelace");
      expect(out).toContain("Subject: Quick favor?");
      expect(out).toContain("NetPro never sends");
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.OPENAI_API_KEY;
      vi.unstubAllGlobals();
    }
  });

  it("--draft without credentials still prints the plan and reports the failure", async () => {
    await seed(conn);
    const result = await executePathDetailed({ draft: true }, "Zoe Target", conn);
    expect(result.output).toContain("Ask Ada Lovelace");
    expect(result.draftError).toContain("No AI provider key configured");
    // The JSON payload carries the same failure for scripts.
    const payload = JSON.parse(result.json) as { draftError?: string };
    expect(payload.draftError).toContain("No AI provider key configured");
  });

  it("--draft + no path says so without throwing", async () => {
    await seed(conn);
    const result = await executePathDetailed({ draft: true, maxDepth: "1" }, "Zoe Target", conn);
    expect(result.output).toContain("No path within 1 hop");
    expect(result.draftError).toContain("nothing to draft");
  });
});
