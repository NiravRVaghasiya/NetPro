import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The people page is a server component: it fetches GET /api/contacts from
// the NetPro server and renders the Add Person entry points (header action
// when contacts exist, "Build your network" when they don't).
type ServerFetchJsonMock = (
  path: string,
  options?: unknown,
) => Promise<{
  ok: boolean;
  status: number;
  serverUrl: string;
  data: unknown;
}>;

const serverFetchJson = vi.hoisted(() => vi.fn<ServerFetchJsonMock>());

vi.mock("@/lib/netpro-server", () => ({
  getServerUrl: () => "http://127.0.0.1:3777",
  serverFetchJson,
}));

import PeoplePage from "./page";

afterEach(() => {
  serverFetchJson.mockReset();
});

async function render(): Promise<string> {
  const element = await PeoplePage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

describe("People page", () => {
  it("shows the Add Person action above an existing network", async () => {
    serverFetchJson.mockImplementation(async () => ({
      ok: true,
      status: 200,
      serverUrl: "http://127.0.0.1:3777",
      data: {
        contacts: [
          {
            id: "c1",
            fullName: "Jane Doe",
            company: "Stripe",
            role: "Engineer",
            relationshipScore: 0.8,
            lastInteraction: "2026-09-01T00:00:00.000Z",
          },
        ],
        total: 1,
      },
    }));
    const html = await render();
    expect(html).toContain("Jane Doe");
    expect(html).toContain("+ Add Person");
    expect(html).not.toContain("Build your network");
  });

  it("offers the empty-state onboarding path when the network is empty", async () => {
    serverFetchJson.mockImplementation(async () => ({
      ok: true,
      status: 200,
      serverUrl: "http://127.0.0.1:3777",
      data: { contacts: [], total: 0 },
    }));
    const html = await render();
    expect(html).toContain("Build your network");
    expect(html).toContain("Add LinkedIn Profile");
    expect(html).toContain("Import Data");
    expect(html).toContain("netpro import contacts.csv");
  });

  it("shows a server banner when the API is unreachable", async () => {
    serverFetchJson.mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const html = await render();
    expect(html).toContain("Server not reachable");
    expect(html).toContain("netpro serve");
  });
});
