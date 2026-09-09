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
// The extraction panel is a client component (useRouter); stub it so the
// server render stays static — its API is covered by the route tests.
vi.mock("./panels", () => ({
  ExtractPanel: ({
    neverExtracted,
    total,
  }: {
    neverExtracted: number;
    total: number;
  }) => <div data-testid="extract-panel">{`${neverExtracted}/${total}`}</div>,
}));

import SkillsPage from "./page";

const NOW = new Date("2026-09-07T12:00:00Z").toISOString();

async function render(params: Record<string, string> = {}): Promise<string> {
  const element = await SkillsPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

function seed(): void {
  fixture.sqlite.exec("DELETE FROM enrichments; DELETE FROM contacts;");
  const rows = [
    {
      id: "a",
      fullName: "Ada Lovelace",
      company: "Engines",
      headline: "Staff engineer — Python, Kubernetes, AWS",
      relationshipScore: 0.9,
    },
    {
      id: "b",
      fullName: "Bob Bridge",
      role: "Data Engineer",
      notes: "SQL and dbt.",
      tags: ["python"],
      relationshipScore: 0.6,
    },
    {
      id: "c",
      fullName: "Cara",
      headline: "Product designer (Figma)",
      skills: ["rust", "figma"],
      relationshipScore: 0.3,
    },
    { id: "gone", fullName: "Ghost", headline: "Python", deletedAt: NOW },
  ];
  for (const r of rows) {
    fixture.conn.db
      .insert(fixture.conn.schema.contacts)
      .values({ ...r, source: "test", createdAt: NOW, updatedAt: NOW })
      .run();
  }
}

beforeEach(seed);
afterAll(() => fixture.sqlite.close());

describe("/skills page", () => {
  it("renders the network skill map and the extraction panel with no target", async () => {
    const html = await render();
    expect(html).toContain("Skills gap");
    expect(html).toContain("What your network knows");
    expect(html).toContain(
      "3 of 3 contacts have at least one recognised skill",
    );
    expect(html).toContain('href="/skills?skills=python"');
    expect(html).toContain("extract-panel");
    expect(html).toContain("2/3"); // never extracted / total
    expect(html).not.toContain("Ghost");
    expect(html).not.toContain("Coverage —");
  });

  it("analyses a target: required skills, coverage table, gaps and ranked matches", async () => {
    const html = await render({
      role: "Data Engineer",
      skills: "python, k8s, swift",
    });
    expect(html).toContain("Target needs <strong>4</strong> skills");
    expect(html).toContain("python, swift, kubernetes, data engineering");
    expect(html).toContain("Coverage — 3/4 skills covered by 3 contacts");
    expect(html).toContain(
      "Nobody in your network covers: <strong>swift</strong>",
    );
    expect(html).toContain('href="/contacts/a"');
    expect(html).toContain("Best matches");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("50%");
    expect(html).toContain('href="/graph?target=a"');
    expect(html).not.toContain("What your network knows");
  });

  it("keeps the form values and reports unrecognised names", async () => {
    const html = await render({ skills: "python, cobol" });
    expect(html).toContain('value="python, cobol"');
    expect(html).toContain("ignored, not in the taxonomy: cobol");
  });

  it("explains a target with no recognisable skills instead of showing an empty table", async () => {
    const html = await render({ description: "a kind person" });
    expect(html).toContain("No taxonomy skills recognised in that target");
    expect(html).not.toContain("Best matches");
  });

  it("never 500s on a hand-typed pathological URL", async () => {
    const html = await render({ description: "x".repeat(10_001) });
    expect(html).toContain('role="alert"');
    expect(html).toContain("10000 characters or fewer");
  });

  it("handles an empty database", async () => {
    fixture.sqlite.exec("DELETE FROM contacts;");
    const html = await render();
    expect(html).toContain("No skills recognised yet");
    expect(html).toContain("import some contacts");
    const analysed = await render({ skills: "python" });
    expect(analysed).toContain(
      "No contact matches any of the required skills yet",
    );
  });
});
