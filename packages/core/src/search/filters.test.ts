// Phase 12 — the new search filters (name, tags, community, contactIds) and
// the skills/tags now carried on every result row.
//
// The fixture is two triangles bridged by b–d (the network.test.ts shape, with
// companies added): Louvain deterministically finds [a,b,c] "acme" and
// [d,e,f] "globex".
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestSqliteConn } from "@netpro/db/src/testing";
import { resolveCommunityMembers } from "../graph/communities";
import { parseStringArray } from "./fetch";
import { searchContacts } from "./query";

const fixture = createTestSqliteConn();
const NOW = "2026-09-07T12:00:00.000Z";

const ids = (res: Awaited<ReturnType<typeof searchContacts>>) =>
  res.contacts.map((c) => c.id).sort();

async function seed() {
  fixture.sqlite.exec("DELETE FROM edges; DELETE FROM contacts;");
  const people = [
    {
      id: "a",
      fullName: "Ada Lovelace",
      company: "Acme",
      role: "Engineer",
      location: "Berlin",
      tags: ["founder", "ai"],
      skills: ["python"],
      relationshipScore: 0.9,
    },
    {
      id: "b",
      fullName: "Bob Builder",
      company: "Acme",
      role: "Designer",
      location: "Berlin",
      tags: ["design"],
      skills: ["kubernetes"],
      relationshipScore: 0.8,
    },
    {
      id: "c",
      fullName: "Cara Chen",
      company: "Acme",
      role: "Engineer",
      location: "Paris",
      tags: [],
      skills: null,
      relationshipScore: 0.3,
    },
    {
      id: "d",
      fullName: "Dan Delta",
      company: "Globex",
      role: "Engineer",
      location: "Berlin",
      tags: ["founder"],
      skills: ["python"],
      relationshipScore: 0.7,
    },
    {
      id: "e",
      fullName: "Eve East",
      company: "Globex",
      role: "Manager",
      location: "Paris",
      tags: ["ops"],
      skills: null,
      relationshipScore: 0.1,
    },
    {
      id: "f",
      fullName: "Fay Fair",
      company: "Globex",
      role: "Engineer",
      location: "Paris",
      tags: null,
      skills: ["aws"],
      relationshipScore: null,
    },
  ];
  for (const p of people) {
    await fixture.conn.db.insert(fixture.conn.schema.contacts).values({
      ...p,
      source: "test",
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  let n = 0;
  for (const [s, t] of [
    ["a", "b"],
    ["b", "c"],
    ["c", "a"],
    ["d", "e"],
    ["e", "f"],
    ["f", "d"],
    ["b", "d"],
  ] as const) {
    await fixture.conn.db.insert(fixture.conn.schema.edges).values({
      id: `e${++n}`,
      sourceId: s,
      targetId: t,
      relation: "colleague",
      strength: 0.7,
      confidence: 1,
      bidirectional: true,
      source: "manual",
      status: "confirmed",
      discoveredAt: NOW,
      updatedAt: NOW,
    });
  }
}

beforeEach(seed);
afterAll(() => fixture.sqlite.close());

describe("name filter", () => {
  it("matches the full name only", async () => {
    const res = await searchContacts(fixture.conn, { name: "ada" });
    expect(res.contacts.map((c) => c.id)).toEqual(["a"]);
  });

  it("combines with other filters", async () => {
    const res = await searchContacts(fixture.conn, {
      name: "e",
      company: "globex",
    });
    expect(ids(res)).toEqual(["d", "e"]);
  });
});

describe("tags filter", () => {
  it("requires every listed tag (AND)", async () => {
    expect(ids(await searchContacts(fixture.conn, { tags: ["founder"] }))).toEqual(
      ["a", "d"],
    );
    expect(
      ids(await searchContacts(fixture.conn, { tags: ["founder", "ai"] })),
    ).toEqual(["a"]);
  });

  it("matches case-insensitively", async () => {
    expect(ids(await searchContacts(fixture.conn, { tags: ["FOUNDER"] }))).toEqual(
      ["a", "d"],
    );
  });

  it("matches whole tags, not substrings inside a tag", async () => {
    // "found" is a substring of the tag "founder" but not a tag itself.
    const res = await searchContacts(fixture.conn, { tags: ["found"] });
    expect(res.contacts).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("matches nothing for unknown tags", async () => {
    const res = await searchContacts(fixture.conn, { tags: ["nope"] });
    expect(res.contacts).toEqual([]);
  });
});

describe("community filter", () => {
  it("filters by label, case-insensitively", async () => {
    expect(ids(await searchContacts(fixture.conn, { community: "acme" }))).toEqual(
      ["a", "b", "c"],
    );
    expect(ids(await searchContacts(fixture.conn, { community: "GLOBEX" }))).toEqual(
      ["d", "e", "f"],
    );
  });

  it("filters by 0-based id and by `Community N`", async () => {
    expect(ids(await searchContacts(fixture.conn, { community: "0" }))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(ids(await searchContacts(fixture.conn, { community: "1" }))).toEqual([
      "d",
      "e",
      "f",
    ]);
    expect(
      ids(await searchContacts(fixture.conn, { community: "Community 1" })),
    ).toEqual(["a", "b", "c"]);
    expect(
      ids(await searchContacts(fixture.conn, { community: "community 2" })),
    ).toEqual(["d", "e", "f"]);
  });

  it("unions substring matches across labels", async () => {
    // Both "acme" and "globex" contain "e".
    expect(ids(await searchContacts(fixture.conn, { community: "e" }))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  it("matches nothing for unknown communities", async () => {
    for (const community of ["nonexistent", "9", "Community 5", ""]) {
      const res = await searchContacts(fixture.conn, { community });
      // A blank selector is not a filter at all — everything matches.
      if (community === "") {
        expect(res.total).toBe(6);
      } else {
        expect(res.contacts).toEqual([]);
        expect(res.total).toBe(0);
      }
    }
  });

  it("intersects with the other filters", async () => {
    expect(
      ids(
        await searchContacts(fixture.conn, {
          community: "acme",
          company: "globex",
        }),
      ),
    ).toEqual([]);
    expect(
      ids(
        await searchContacts(fixture.conn, {
          community: "globex",
          role: "engineer",
        }),
      ),
    ).toEqual(["d", "f"]);
  });

  it("restricts the fused keyword path too (arms share the filter)", async () => {
    const res = await searchContacts(
      fixture.conn,
      { query: "engineer", community: "globex", mode: "keyword" },
    );
    expect(ids(res)).toEqual(["d", "f"]);
  });

  it("resolves member ids directly for surfaces that need them", async () => {
    expect(await resolveCommunityMembers(fixture.conn, "acme")).toEqual({
      label: "acme",
      communityIds: [0],
      memberIds: ["a", "b", "c"],
    });
    expect(await resolveCommunityMembers(fixture.conn, "9")).toBeNull();
    expect(await resolveCommunityMembers(fixture.conn, "   ")).toBeNull();
  });
});

describe("contactIds restriction", () => {
  it("restricts to the given ids", async () => {
    const res = await searchContacts(fixture.conn, { contactIds: ["a", "f"] });
    expect(ids(res)).toEqual(["a", "f"]);
    expect(res.total).toBe(2);
  });

  it("matches nothing for an empty set", async () => {
    const res = await searchContacts(fixture.conn, { contactIds: [] });
    expect(res.contacts).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("intersects with the community membership", async () => {
    const res = await searchContacts(fixture.conn, {
      community: "acme",
      contactIds: ["a", "d"],
    });
    expect(res.contacts.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("skills and tags on result rows", () => {
  it("carries the stored verdicts for chips and explanations", async () => {
    const res = await searchContacts(fixture.conn, { name: "ada" });
    expect(res.contacts[0]).toMatchObject({
      id: "a",
      tags: ["founder", "ai"],
      skills: ["python"],
    });
    const empty = await searchContacts(fixture.conn, { name: "cara" });
    expect(empty.contacts[0]).toMatchObject({ id: "c", tags: [], skills: null });
    const missing = await searchContacts(fixture.conn, { name: "fay" });
    expect(missing.contacts[0]).toMatchObject({
      id: "f",
      tags: null,
      skills: ["aws"],
    });
  });
});

describe("parseStringArray", () => {
  it("accepts arrays, Postgres-style JSON text, and null", () => {
    expect(parseStringArray(["a", "b"])).toEqual(["a", "b"]);
    expect(parseStringArray('["a","b"]')).toEqual(["a", "b"]);
    expect(parseStringArray(null)).toBeNull();
    expect(parseStringArray(undefined)).toBeNull();
    expect(parseStringArray("")).toBeNull();
  });

  it("drops non-strings and refuses corrupt payloads", () => {
    expect(parseStringArray(["a", 1, null])).toEqual(["a"]);
    expect(parseStringArray("not json")).toBeNull();
    expect(parseStringArray('{"a":1}')).toBeNull();
    expect(parseStringArray(42)).toBeNull();
  });
});
