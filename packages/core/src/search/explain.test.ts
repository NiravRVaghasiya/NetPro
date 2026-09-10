// Phase 12 — match explanations: every surface renders these lines verbatim,
// so the contract is pinned here, once.
import { describe, expect, it } from "vitest";
import { explainMatch } from "./explain";
import type { ContactSearchResult } from "./types";

function contact(overrides: Partial<ContactSearchResult> = {}): ContactSearchResult {
  return {
    id: "c1",
    fullName: "Sarah Chen",
    email: "sarah@acme.com",
    headline: "AI researcher",
    company: "Acme",
    role: "Senior Engineer",
    seniority: "senior",
    industry: "Software",
    location: "Berlin",
    linkedinUrl: null,
    relationshipScore: 0.8,
    lastInteraction: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    source: "test",
    tags: ["founder", "ai"],
    skills: ["python", "kubernetes"],
    ...overrides,
  };
}

const texts = (c: ContactSearchResult, opts: Parameters<typeof explainMatch>[1]) =>
  explainMatch(c, opts).map((r) => r.text);

describe("explainMatch — free-text attribution", () => {
  it("attributes each term to the field it matched, in field-priority order", () => {
    // "sarah" hits the name and the email; "acme" hits the email and the
    // company. Terms stay grouped (sarah's fields, then acme's).
    expect(texts(contact(), { query: "sarah acme" })).toEqual([
      'Name matches "sarah"',
      'Email matches "sarah"',
      'Email matches "acme"',
      "Works at Acme",
    ]);
  });

  it("uses the plan's phrasing for role and location hits", () => {
    expect(texts(contact(), { query: "engineer berlin" })).toEqual([
      "Works as Senior Engineer",
      "Based in Berlin",
    ]);
  });

  it("attributes email and headline terms", () => {
    const c = contact();
    expect(texts(c, { query: "sarah@acme.com researcher" })).toEqual([
      'Email matches "sarah@acme.com"',
      'Headline matches "researcher"',
    ]);
  });

  it("attributes one term to every field it matches", () => {
    // "acme" is in both the company and the email.
    expect(texts(contact(), { query: "acme" })).toEqual([
      'Email matches "acme"',
      "Works at Acme",
    ]);
  });

  it("falls back to Related-to for terms no lexical field explains", () => {
    // A keyword/semantic arm hit (stemming, vector similarity): honest about
    // what it cannot attribute rather than silent or fabricated.
    expect(texts(contact(), { query: "blockchain" })).toEqual([
      'Related to "blockchain"',
    ]);
  });
});

describe("explainMatch — structured filters", () => {
  it("cites the row's own values for company/role/location/industry/name", () => {
    const c = contact();
    expect(
      texts(c, {
        name: "sarah",
        company: "acm",
        role: "engineer",
        location: "berl",
        industry: "soft",
      }),
    ).toEqual([
      'Name contains "sarah"',
      "Works at Acme",
      "Works as Senior Engineer",
      "Based in Berlin",
      "Works in Software",
    ]);
  });

  it("cites seniority, email presence, score, and recency", () => {
    expect(
      texts(contact(), {
        seniority: "senior",
        hasEmail: true,
        minScore: 0.5,
        lastActiveWithinDays: 30,
      }),
    ).toEqual([
      "Seniority: senior",
      "Has email address",
      "Relationship strength 0.80 (minimum 0.5)",
      "Active within the last 30 days",
    ]);
  });

  it("cites each matched skill canonically and each tag in owner casing", () => {
    expect(
      texts(contact(), { skills: ["k8s", "python"], tags: ["AI", "founder"] }),
    ).toEqual([
      "Has skill: kubernetes",
      "Has skill: python",
      'Tagged "ai"',
      'Tagged "founder"',
    ]);
  });

  it("cites the community by construction (graph-computed, not row-carried)", () => {
    expect(texts(contact(), { community: "acme" })).toEqual([
      'In community "acme"',
    ]);
  });
});

describe("explainMatch — honesty rules", () => {
  it("deduplicates identical lines from terms and filters", () => {
    expect(texts(contact(), { query: "acme", company: "acme" })).toEqual([
      'Email matches "acme"',
      "Works at Acme",
    ]);
  });

  it("emits nothing for a browse-all query", () => {
    expect(explainMatch(contact(), {})).toEqual([]);
    expect(explainMatch(contact(), { sort: "score", limit: 10 })).toEqual([]);
  });

  it("never cites a condition the row visibly fails", () => {
    const c = contact({
      relationshipScore: 0.2,
      lastInteraction: "2020-01-01T00:00:00.000Z",
      skills: null,
      tags: null,
      email: null,
    });
    expect(
      texts(c, {
        minScore: 0.9,
        lastActiveWithinDays: 7,
        skills: ["python"],
        tags: ["founder"],
        hasEmail: true,
        seniority: "c_level",
        community: "  ",
      }),
    ).toEqual([]);
  });

  it("skips unknown skills rather than citing them", () => {
    expect(texts(contact(), { skills: ["not-a-real-skill"] })).toEqual([]);
  });

  it("keeps kind/text pairs stable for surfaces to style", () => {
    expect(explainMatch(contact(), { query: "sarah", minScore: 0.5 })).toEqual([
      { kind: "name", text: 'Name matches "sarah"' },
      { kind: "email", text: 'Email matches "sarah"' },
      {
        kind: "score",
        text: "Relationship strength 0.80 (minimum 0.5)",
      },
    ]);
  });
});
