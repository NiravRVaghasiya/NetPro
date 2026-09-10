import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The page reads the local installation identity, which would touch
// ~/.netpro on the machine running the tests. Pin it instead.
vi.mock("@/lib/local-owner", () => ({
  resolveInstallationIdentity: () => ({
    identity: {
      id: "ins_test_installation",
      createdAt: "2026-09-10T00:00:00.000Z",
      owner: "Test Owner",
    },
    persisted: true,
  }),
}));

// Provider status comes from the NetPro server (Phase 17) — never from
// process.env in the browser layer. Pin the client like the scan page does.
type ProviderFetch = (path: string) => Promise<{
  ok: boolean;
  status: number;
  serverUrl: string;
  data: unknown;
}>;

const serverFetchJson = vi.hoisted(() => vi.fn<ProviderFetch>());

vi.mock("@/lib/netpro-server", () => ({
  getServerUrl: () => "http://127.0.0.1:3777",
  serverFetchJson,
}));

import SettingsPage from "./page";

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

describe("settings configuration status", () => {
  it("never renders secret values and links to the private card editor", async () => {
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
    vi.stubEnv("NETPRO_AUTH_MODE", "github");
    serverFetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      serverUrl: "http://127.0.0.1:3777",
      data: PROVIDERS_CONFIGURED,
    });
    const html = await render();
    expect(html).not.toContain("SECRET_VALUE_NOT_FOR_HTML");
    expect(html).not.toContain("123456789");
    expect(html).toContain('href="/settings/card"');
    // GitHub is described as optional, and the auth mode is what is surfaced.
    expect(html).toContain("NETPRO_AUTH_MODE");
    expect(html).toContain("ins_test_installation");
  });

  it("shows the installation identity without exposing anything secret (phase 5)", async () => {
    vi.stubEnv("NETPRO_AUTH_MODE", "local");
    serverFetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      serverUrl: "http://127.0.0.1:3777",
      data: PROVIDERS_CONFIGURED,
    });
    const html = await render();
    expect(html).toContain("ins_test_installation");
    expect(html).toContain("Test Owner");
  });

  it("does not call OAuth configured when only one credential is set", async () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "configured-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");
    serverFetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      serverUrl: "http://127.0.0.1:3777",
      data: PROVIDERS_CONFIGURED,
    });
    const html = await render();
    const row = html
      .split("<tr")
      .find((part) => part.includes("GitHub OAuth (optional integration)"));
    expect(row).toBeDefined();
    expect(row).toContain("not set");
  });
});

describe("settings provider status (Phase 17)", () => {
  it("renders the plan's provider strips from the server snapshot", async () => {
    serverFetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      serverUrl: "http://127.0.0.1:3777",
      data: PROVIDERS_CONFIGURED,
    });

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
  });
});
