import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Phase 24 — the settings page reads the installation identity from the
// NetPro server (GET /api/identity) and provider status from GET /api/providers.
// It never reads ~/.netpro or provider keys in this process. Pin the client.
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

import SettingsPage from "./page";

const IDENTITY = {
  installation: {
    id: "ins_test_installation",
    createdAt: "2026-09-10T00:00:00.000Z",
    owner: "Test Owner",
  },
};

const PROVIDERS_CONFIGURED = {
  runsWithoutProviders: true,
  categories: [
    { id: "ai", label: "AI", configured: true, detail: "OpenAI configured", providers: [] },
    {
      id: "enrichment",
      label: "Enrichment",
      configured: true,
      detail: "Hunter configured",
      providers: [],
    },
    { id: "embeddings", label: "Embeddings", configured: false, detail: "Disabled", providers: [] },
    { id: "content", label: "Content", configured: false, detail: "Not configured", providers: [] },
  ],
  capabilities: { keywordSearch: "available", semanticSearch: "disabled" },
  degraded: [
    {
      capability: "semanticSearch",
      label: "Semantic search",
      reason: "Keyword search is unaffected.",
      enable: "Set EMBEDDINGS_PROVIDER=openai …",
    },
  ],
  warnings: [],
};

afterEach(() => {
  serverFetchJson.mockReset();
  vi.unstubAllEnvs();
});

async function render(): Promise<string> {
  const element = await SettingsPage();
  return renderToStaticMarkup(element as unknown as React.ReactElement);
}

function mockServer() {
  serverFetchJson.mockImplementation(async (path) => {
    if (path === "/api/identity") {
      return { ok: true, status: 200, serverUrl: "http://127.0.0.1:3777", data: IDENTITY };
    }
    if (path === "/api/providers") {
      return {
        ok: true,
        status: 200,
        serverUrl: "http://127.0.0.1:3777",
        data: PROVIDERS_CONFIGURED,
      };
    }
    throw new Error(`unexpected path ${path}`);
  });
}

describe("settings configuration status", () => {
  it("renders the installation identity from the server without exposing secrets", async () => {
    mockServer();
    const html = await render();
    expect(html).toContain("ins_test_installation");
    expect(html).toContain("Test Owner");
    expect(html).toContain("~/.netpro/config.toml");
    // The page no longer links to the removed legacy surfaces.
    expect(html).not.toContain("/settings/card");
    expect(html).not.toContain("/settings/team");
    expect(html).not.toContain("/settings/plugins");
    expect(html).not.toContain("/settings/webhooks");
  });

  it("does not render secret values", async () => {
    for (const key of [
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "HUNTER_API_KEY",
      "PDL_API_KEY",
      "CLEARBIT_API_KEY",
    ]) {
      vi.stubEnv(key, "SECRET_VALUE_NOT_FOR_HTML");
    }
    vi.stubEnv("NETPRO_OWNER_GITHUB_ID", "123456789");
    mockServer();
    const html = await render();
    expect(html).not.toContain("SECRET_VALUE_NOT_FOR_HTML");
    expect(html).not.toContain("123456789");
  });
});

describe("settings provider status (Phase 17)", () => {
  it("renders the plan's provider strips from the server snapshot", async () => {
    mockServer();
    const html = await render();
    expect(html).toContain("AI");
    expect(html).toContain("OpenAI configured");
    expect(html).toContain("Hunter configured");
    expect(html).toContain("Disabled");
    // Optionality is stated, not implied.
    expect(html).toContain("all optional");
    // What is off says how to turn it on.
    expect(html).toContain("Semantic search");
    expect(html).toContain("Set EMBEDDINGS_PROVIDER=openai");
    // Status came from the server, not from this process's environment.
    expect(serverFetchJson).toHaveBeenCalledWith("/api/providers");
  });

  it("degrades to a clear message when the NetPro server is unreachable", async () => {
    serverFetchJson.mockRejectedValue(new Error("ECONNREFUSED"));
    const html = await render();
    expect(html).toContain("Provider status is unavailable");
    expect(html).toContain("netpro serve");
    // Identity also degrades to the same instruction.
    expect(html).toContain("This installation");
  });
});
