vi.mock("@/lib/authz", () => ({
  requireScope: async () => ({
    workspaceId: "default",
    userId: "test-user",
    role: "owner",
  }),
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

type ServerFetchJsonMock = (
  path: string,
  options?: unknown,
) => Promise<{ ok: boolean; status: number; serverUrl: string; data: unknown }>;

const serverFetchJson = vi.hoisted(() => vi.fn<ServerFetchJsonMock>());

vi.mock("@/lib/netpro-server", () => ({
  getServerUrl: () => "http://127.0.0.1:3777",
  serverFetchJson,
}));

import ScanPage from "./page";

const SCAN_RESULT = {
  source: "linkedin_csv",
  processed: 2,
  total: 2,
  newContacts: 2,
  updatedContacts: 0,
  relationships: 1,
  relationshipsDiscovered: 1,
  communities: 1,
  enrichment: { configured: false, enriched: 0, progress: 0, skipped: 0, error: null },
  index: { scanned: 2, indexed: 2, skipped: 0, pruned: 0, keywordIndexAvailable: true },
  startedAt: "2026-09-10T00:00:00.000Z",
  completedAt: "2026-09-10T00:00:05.000Z",
};

async function render(): Promise<string> {
  const element = await ScanPage();
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

beforeEach(() => {
  serverFetchJson.mockReset();
});

describe("Scan page", () => {
  it("renders the SCAN view with the latest scan snapshot", async () => {
    serverFetchJson.mockImplementation(async (path) => {
      if (path.startsWith("/api/jobs")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: {
            total: 1,
            jobs: [
              {
                id: "scan-123",
                type: "scan",
                status: "completed",
                progress: 100,
                startedAt: "2026-09-10T00:00:00.000Z",
                completedAt: "2026-09-10T00:00:05.000Z",
                metadata: { result: SCAN_RESULT },
              },
            ],
          },
        };
      }
      if (path.startsWith("/api/providers")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: { enrichment: { configured: false } },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const html = await render();
    expect(html).toContain("Scan");
    expect(html).toContain("Start scan");
    expect(html).toContain("Processed");
    expect(html).toContain("2 / 2");
    expect(html).toContain("New contacts");
    expect(html).toContain("Updated contacts");
    expect(html).toContain("Relationships discovered");
    expect(html).toContain("Enrichment");
  });

  it("renders an empty state when no scan has run", async () => {
    serverFetchJson.mockImplementation(async (path) => {
      if (path.startsWith("/api/jobs")) {
        return { ok: true, status: 200, serverUrl: "http://127.0.0.1:3777", data: { total: 0, jobs: [] } };
      }
      return { ok: true, status: 200, serverUrl: "http://127.0.0.1:3777", data: { enrichment: { configured: false } } };
    });

    const html = await render();
    expect(html).toContain("No scan has run yet");
  });

  it("shows a banner when the server is unreachable", async () => {
    serverFetchJson.mockRejectedValue(new Error("ECONNREFUSED"));

    const html = await render();
    expect(html).toContain("NetPro server not reachable");
  });

  it("says where a scan came from — the CLI and the UI produce the same job (Phase 16)", async () => {
    serverFetchJson.mockImplementation(async (path) => {
      if (path.startsWith("/api/jobs")) {
        return {
          ok: true,
          status: 200,
          serverUrl: "http://127.0.0.1:3777",
          data: {
            total: 1,
            jobs: [
              {
                id: "scan-from-terminal",
                type: "scan",
                status: "completed",
                progress: 100,
                startedAt: "2026-09-10T00:00:00.000Z",
                completedAt: "2026-09-10T00:00:05.000Z",
                metadata: { result: SCAN_RESULT, origin: "cli" },
              },
            ],
          },
        };
      }
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: { enrichment: { configured: false } },
      };
    });

    const html = await render();
    expect(html).toContain("started in a terminal");
    expect(html).toContain("netpro scan");
  });

  it("shows provider status so an offline scan is self-explanatory (Phase 17)", async () => {
    serverFetchJson.mockImplementation(async (path) => {
      if (path.startsWith("/api/jobs")) {
        return { ok: true, status: 200, serverUrl: "http://127.0.0.1:3777", data: { total: 0, jobs: [] } };
      }
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: {
          enrichment: { configured: false },
          runsWithoutProviders: true,
          categories: [
            { id: "enrichment", label: "Enrichment", configured: false, detail: "Not configured", providers: [] },
            { id: "embeddings", label: "Embeddings", configured: false, detail: "Disabled", providers: [] },
          ],
          degraded: [
            {
              capability: "enrichment",
              label: "Contact enrichment",
              reason: "Scans run fully offline.",
              enable: "Set HUNTER_API_KEY …",
            },
          ],
        },
      };
    });

    const html = await render();
    expect(html).toContain("Providers");
    expect(html).toContain("Enrichment");
    expect(html).toContain("all optional");
    expect(html).toContain("Contact enrichment");
  });
});
