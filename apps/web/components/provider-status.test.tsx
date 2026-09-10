import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderStatus, type ProviderStatusPayload } from "./provider-status";

function category(
  id: string,
  label: string,
  configured: boolean,
  detail: string,
  providers: Array<{ id: string; label: string; configured: boolean; source?: "env" | "keychain" | "none"; purpose?: string }> = []
) {
  return { id, label, configured, detail, providers };
}

const HUNTER_ONLY: ProviderStatusPayload = {
  runsWithoutProviders: true,
  categories: [
    category("ai", "AI", false, "Not configured", [
      { id: "openai", label: "OpenAI", configured: false, purpose: "AI drafts." },
      { id: "anthropic", label: "Anthropic", configured: false, purpose: "AI drafts." },
    ]),
    category("enrichment", "Enrichment", true, "Hunter configured", [
      { id: "hunter", label: "Hunter", configured: true, source: "env", purpose: "Email finding." },
      { id: "pdl", label: "People Data Labs", configured: false },
    ]),
    category("embeddings", "Embeddings", false, "Disabled", [
      { id: "embeddings-openai", label: "OpenAI embeddings", configured: false },
    ]),
    category("content", "Content", false, "Not configured", [
      { id: "devto", label: "DEV.to", configured: false },
    ]),
  ],
  capabilities: { keywordSearch: "available", semanticSearch: "disabled" },
  degraded: [
    {
      capability: "semanticSearch",
      label: "Semantic search",
      reason: "Keyword search is unaffected.",
      enable: "Set EMBEDDINGS_PROVIDER=openai plus EMBEDDINGS_API_KEY.",
    },
  ],
  warnings: [],
};

describe("ProviderStatus", () => {
  it("renders the plan's three strips", () => {
    const html = renderToStaticMarkup(<ProviderStatus status={HUNTER_ONLY} />);

    expect(html).toContain("AI");
    expect(html).toContain("Not configured");
    expect(html).toContain("Enrichment");
    expect(html).toContain("Hunter configured");
    expect(html).toContain("Embeddings");
    expect(html).toContain("Disabled");
    expect(html).toContain("all optional");
  });

  it("explains what is off and how to switch it on", () => {
    const html = renderToStaticMarkup(<ProviderStatus status={HUNTER_ONLY} />);

    expect(html).toContain("Semantic search");
    expect(html).toContain("Keyword search is unaffected.");
    expect(html).toContain("EMBEDDINGS_PROVIDER=openai");
  });

  it("never renders a key — only where a configured key came from", () => {
    const html = renderToStaticMarkup(<ProviderStatus status={HUNTER_ONLY} />);

    expect(html).toContain("configured (env)");
    expect(html).not.toContain("sk-");
    expect(html).not.toContain("HUNTER_API_KEY");
  });

  it("renders a warning banner for a misconfigured provider", () => {
    const html = renderToStaticMarkup(
      <ProviderStatus
        status={{ ...HUNTER_ONLY, warnings: ["Unknown EMBEDDINGS_PROVIDER &quot;voyage&quot;."] }}
      />
    );
    expect(html).toContain("EMBEDDINGS_PROVIDER");
  });

  it("says status is unavailable instead of guessing when there is no snapshot", () => {
    const html = renderToStaticMarkup(<ProviderStatus status={null} />);

    expect(html).toContain("Provider status is unavailable");
    expect(html).toContain("netpro serve");
  });

  it("hides the per-provider detail list when asked to", () => {
    const compact = renderToStaticMarkup(
      <ProviderStatus status={HUNTER_ONLY} showDetails={false} />
    );
    expect(compact).toContain("Hunter configured");
    expect(compact).not.toContain("Email finding.");
  });
});
