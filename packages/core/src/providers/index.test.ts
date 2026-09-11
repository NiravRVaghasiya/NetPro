// packages/core/src/providers/index.test.ts
//
// Phase 17 — Optional AI and Enrichment.
//
// The contract under test is the plan's, stated as behaviour:
//
//   * NetPro functions with no provider configured — capabilities report
//     "disabled" with an explanation, never an error.
//   * When providers are configured, they enhance: the affected capabilities
//     flip to "available".
//   * No surface ever leaks a key.

import { describe, it, expect } from "vitest";
import {
  PROVIDER_CATALOG,
  formatProviderStatus,
  configuredEnrichmentProviders,
  resolveProviderStatus,
  type ProviderStatusSnapshot,
} from "./index";

const EMPTY: Record<string, string | undefined> = {};

describe("resolveProviderStatus", () => {
  it("reports everything optional and nothing configured on an empty environment", () => {
    const status = resolveProviderStatus(EMPTY);

    expect(status.runsWithoutProviders).toBe(true);
    expect(status.ai.configured).toBe(false);
    expect(status.enrichment.configured).toBe(false);
    expect(status.embeddings.configured).toBe(false);

    // Offline capabilities are always available.
    expect(status.capabilities.import).toBe("available");
    expect(status.capabilities.scan).toBe("available");
    expect(status.capabilities.keywordSearch).toBe("available");
    expect(status.capabilities.graphAnalytics).toBe("available");

    // Provider-backed ones are disabled, with a reason and a way to turn them on.
    expect(status.capabilities.semanticSearch).toBe("disabled");
    expect(status.capabilities.enrichment).toBe("disabled");
    expect(status.capabilities.aiOutreach).toBe("disabled");

    const capabilities = status.degraded.map((d) => d.capability);
    expect(capabilities).toContain("semanticSearch");
    expect(capabilities).toContain("enrichment");
    expect(capabilities).toContain("aiOutreach");
    for (const entry of status.degraded) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.enable.length).toBeGreaterThan(0);
    }
  });

  it("marks the plan's three strips exactly: not configured / configured / disabled", () => {
    const status = resolveProviderStatus({ HUNTER_API_KEY: "hunter-secret" });

    expect(status.ai).toMatchObject({ status: "not configured", configured: false });
    expect(status.enrichment).toMatchObject({ status: "configured", configured: true });
    expect(status.enrichment.detail).toBe("Hunter configured");
    expect(status.embeddings).toMatchObject({ status: "disabled", configured: false });
  });

  it("reads keys from either the environment or the CLI keychain", () => {
    const fromEnv = resolveProviderStatus({ PDL_API_KEY: "pdl-secret" });
    const pdl = fromEnv.providers.find((p) => p.id === "pdl");
    expect(pdl).toMatchObject({ configured: true, source: "env" });

    const fromKeychain = resolveProviderStatus(EMPTY, {
      keychain: { "enrichment.clearbit": "clearbit-secret" },
    });
    const clearbit = fromKeychain.providers.find((p) => p.id === "clearbit");
    expect(clearbit).toMatchObject({ configured: true, source: "keychain" });
    expect(fromKeychain.enrichment.configuredProviders).toEqual(["Clearbit"]);
  });

  it("treats a bare OPENAI_API_KEY as AI configured but embeddings disabled", () => {
    const status = resolveProviderStatus({ OPENAI_API_KEY: "sk-test" });

    expect(status.ai.configured).toBe(true);
    expect(status.ai.configuredProviders).toEqual(["OpenAI"]);
    expect(status.capabilities.aiOutreach).toBe("available");
    // Embeddings are opt-in: EMBEDDINGS_PROVIDER must say so.
    expect(status.embeddings.configured).toBe(false);
    expect(status.embeddings.status).toBe("disabled");
    expect(status.capabilities.semanticSearch).toBe("disabled");
  });

  it("enables embeddings only with an explicit provider and a key", () => {
    const enabled = resolveProviderStatus({
      EMBEDDINGS_PROVIDER: "openai",
      EMBEDDINGS_API_KEY: "sk-embeddings",
    });
    expect(enabled.embeddings.configured).toBe(true);
    expect(enabled.embeddings.status).toBe("configured");
    expect(enabled.capabilities.semanticSearch).toBe("available");
    expect(enabled.degraded.map((d) => d.capability)).not.toContain("semanticSearch");

    // Explicitly off wins over a present key.
    const off = resolveProviderStatus({ EMBEDDINGS_PROVIDER: "disabled", OPENAI_API_KEY: "sk-test" });
    expect(off.embeddings.configured).toBe(false);
    expect(off.warnings).toEqual([]);
  });

  it("reports a misconfigured provider without throwing", () => {
    const status = resolveProviderStatus({ EMBEDDINGS_PROVIDER: "voyage" });

    expect(status.embeddings.configured).toBe(false);
    expect(status.capabilities.semanticSearch).toBe("disabled");
    expect(status.warnings.join(" ")).toContain("EMBEDDINGS_PROVIDER");
  });

  it("never leaks a key value into the snapshot", () => {
    const status = resolveProviderStatus({
      OPENAI_API_KEY: "sk-super-secret",
      ANTHROPIC_API_KEY: "sk-ant-super-secret",
      HUNTER_API_KEY: "hunter-super-secret",
      PDL_API_KEY: "pdl-super-secret",
      CLEARBIT_API_KEY: "clearbit-super-secret",
      EMBEDDINGS_PROVIDER: "openai",
      EMBEDDINGS_API_KEY: "embeddings-super-secret",
    });

    const serialized = JSON.stringify(status);
    for (const secret of [
      "sk-super-secret",
      "sk-ant-super-secret",
      "hunter-super-secret",
      "pdl-super-secret",
      "clearbit-super-secret",
      "embeddings-super-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("describes every catalog entry and marks each one optional", () => {
    const status = resolveProviderStatus(EMPTY);
    expect(status.providers).toHaveLength(PROVIDER_CATALOG.length);
    for (const provider of status.providers) {
      expect(provider.optional).toBe(true);
      expect(provider.purpose.length).toBeGreaterThan(0);
      expect(provider.envVars.length).toBeGreaterThan(0);
    }
  });

  it("accepts an injected clock so the snapshot is deterministic", () => {
    const status = resolveProviderStatus(EMPTY, { now: () => new Date("2026-01-01T00:00:00.000Z") });
    expect(status.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reads keys from the encrypted server vault with source vault", () => {
    const status = resolveProviderStatus(EMPTY, {
      vault: { "outreach.openai": "present", "enrichment.hunter": "present" },
    });
    expect(status.providers.find((p) => p.id === "openai")).toMatchObject({
      configured: true,
      source: "vault",
    });
    expect(status.providers.find((p) => p.id === "hunter")).toMatchObject({
      configured: true,
      source: "vault",
    });
    expect(status.ai.configuredProviders).toEqual(["OpenAI"]);
    expect(status.capabilities.aiOutreach).toBe("available");
    expect(status.capabilities.enrichment).toBe("available");
    // Env still wins for display when both hold a key.
    const both = resolveProviderStatus(
      { OPENAI_API_KEY: "env-key" },
      { vault: { "outreach.openai": "present" } },
    );
    expect(both.providers.find((p) => p.id === "openai")).toMatchObject({
      configured: true,
      source: "env",
    });
  });

  it("counts a vault key toward the embeddings gate", () => {
    const status = resolveProviderStatus(
      { EMBEDDINGS_PROVIDER: "openai" },
      { vault: { "embeddings.openai": "present" } },
    );
    expect(status.embeddings.configured).toBe(true);
    expect(status.embeddings.status).toBe("configured");
    expect(status.capabilities.semanticSearch).toBe("available");
  });

  it("never leaks a vault marker into the snapshot", () => {
    const status = resolveProviderStatus(EMPTY, {
      vault: { "outreach.openai": "marker-not-a-key" },
    });
    expect(JSON.stringify(status)).not.toContain("marker-not-a-key");
  });
});

describe("configuredEnrichmentProviders", () => {
  it("lists only the enrichment providers that are configured", () => {
    expect(configuredEnrichmentProviders(EMPTY)).toEqual([]);
    expect(configuredEnrichmentProviders({ HUNTER_API_KEY: "k", CLEARBIT_API_KEY: "k" })).toEqual([
      "hunter",
      "clearbit",
    ]);
  });
});

describe("formatProviderStatus", () => {
  const render = (status: ProviderStatusSnapshot): string => formatProviderStatus(status);

  it("prints the plan's three status strips", () => {
    const text = render(resolveProviderStatus({ HUNTER_API_KEY: "k" }));

    expect(text).toContain("AI           ● Not configured");
    expect(text).toContain("Enrichment   ● Hunter configured");
    expect(text).toContain("Embeddings   ● Disabled");
  });

  it("says NetPro runs without providers and explains what is off", () => {
    const text = render(resolveProviderStatus(EMPTY));

    expect(text).toContain("all optional");
    expect(text).toContain("Contact enrichment");
    expect(text).toContain("netpro config set enrichment.hunter");
  });
});
