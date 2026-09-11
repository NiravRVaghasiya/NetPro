import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CATALOG } from "../providers";
import { VaultError } from "./key-vault";
import {
  checkApiKeyFormat,
  connectableProvider,
  KEY_TEST_MESSAGES,
  listConnectableProviders,
  providerForVaultSlot,
  testProviderKey,
  vaultSlotForProvider,
} from "./provider-keys";

const SECRET = "sk-test-secret-key-material";

describe("provider ↔ vault slot mapping", () => {
  it("covers every catalog provider exactly once", () => {
    const providers = listConnectableProviders();
    expect(providers.map((p) => p.id).sort()).toEqual(
      PROVIDER_CATALOG.map((p) => p.id).sort(),
    );
    const slots = providers.map((p) => p.vaultSlot);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("maps the documented slots", () => {
    expect(vaultSlotForProvider("openai")).toBe("outreach.openai");
    expect(vaultSlotForProvider("anthropic")).toBe("outreach.anthropic");
    expect(vaultSlotForProvider("hunter")).toBe("enrichment.hunter");
    expect(vaultSlotForProvider("pdl")).toBe("enrichment.pdl");
    expect(vaultSlotForProvider("clearbit")).toBe("enrichment.clearbit");
    expect(vaultSlotForProvider("embeddings-openai")).toBe("embeddings.openai");
    expect(vaultSlotForProvider("devto")).toBe("content.devto");
    expect(vaultSlotForProvider("twitter")).toBe("content.twitter");
    expect(vaultSlotForProvider("github")).toBe("content.github");
  });

  it("rejects unknown providers and slots", () => {
    expect(() => vaultSlotForProvider("nope")).toThrow(VaultError);
    expect(() => connectableProvider("nope")).toThrow(VaultError);
    expect(providerForVaultSlot("outreach.openai")).toBe("openai");
    expect(providerForVaultSlot("plugin.custom.key")).toBeNull();
  });

  it("marks credit-consuming lookups as not remotely validatable", () => {
    expect(connectableProvider("pdl").remotelyValidatable).toBe(false);
    expect(connectableProvider("pdl").validationNote).toContain("credits");
    expect(connectableProvider("clearbit").remotelyValidatable).toBe(false);
    expect(connectableProvider("openai").remotelyValidatable).toBe(true);
  });
});

describe("checkApiKeyFormat", () => {
  it("accepts a normal key", () => {
    expect(checkApiKeyFormat("hunter", "abc123XYZ-_~.")).toEqual({ ok: true, warnings: [] });
  });

  it("rejects short, long, and whitespace-bearing keys without echoing them", () => {
    for (const bad of ["abc", "z".repeat(5000), "qw er ty ui op", "line\nbreak\tkey"]) {
      const result = checkApiKeyFormat("openai", bad);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).not.toContain("abc");
      expect(result.error).not.toContain("zzzzzzzz");
      expect(result.error).not.toContain("qw er");
      expect(result.error).not.toContain("line");
    }
  });

  it("warns (not rejects) on unexpected documented prefixes", () => {
    const openai = checkApiKeyFormat("openai", "not-an-openai-key");
    expect(openai.ok).toBe(true);
    expect(openai.warnings).toHaveLength(1);
    expect(checkApiKeyFormat("openai", "sk-valid-looking").warnings).toHaveLength(0);
    expect(checkApiKeyFormat("anthropic", "sk-ant-valid").warnings).toHaveLength(0);
    expect(checkApiKeyFormat("anthropic", "sk-something-else").warnings).toHaveLength(1);
  });
});

describe("testProviderKey", () => {
  function mockFetch(status: number) {
    return vi.fn(async () => new Response("{}", { status }));
  }

  it("reports valid on 2xx without leaking the key", async () => {
    const fetchImpl = mockFetch(200);
    const outcome = await testProviderKey("openai", SECRET, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(outcome).toEqual({ status: "valid", message: KEY_TEST_MESSAGES.valid });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const [url, init] = calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
  });

  it("reports invalid on 401/403", async () => {
    for (const status of [401, 403]) {
      const outcome = await testProviderKey("github", SECRET, {
        fetchImpl: mockFetch(status) as unknown as typeof fetch,
      });
      expect(outcome).toEqual({ status: "invalid", message: KEY_TEST_MESSAGES.invalid });
    }
  });

  it("reports unreachable on rate limits, server errors, and network failures", async () => {
    for (const status of [429, 500, 404]) {
      const outcome = await testProviderKey("anthropic", SECRET, {
        fetchImpl: mockFetch(status) as unknown as typeof fetch,
      });
      expect(outcome).toEqual({ status: "unreachable", message: KEY_TEST_MESSAGES.unreachable });
    }
    const throwing = vi.fn(async () => {
      throw new Error(`boom ${SECRET} https://api.hunter.io/v2/account?api_key=${SECRET}`);
    });
    const outcome = await testProviderKey("hunter", SECRET, {
      fetchImpl: throwing as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("unreachable");
    // Even a hostile fetch error carrying the URL must not surface the key.
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("sends provider-appropriate requests", async () => {
    const firstCall = (fn: ReturnType<typeof mockFetch>): [string, RequestInit] =>
      (fn.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;

    const anthropic = mockFetch(200);
    await testProviderKey("anthropic", SECRET, { fetchImpl: anthropic as unknown as typeof fetch });
    const [anthropicUrl, anthropicInit] = firstCall(anthropic);
    expect(anthropicUrl).toBe("https://api.anthropic.com/v1/models");
    expect(anthropicInit).toMatchObject({
      headers: { "x-api-key": SECRET, "anthropic-version": "2023-06-01" },
    });

    const hunter = mockFetch(200);
    await testProviderKey("hunter", SECRET, { fetchImpl: hunter as unknown as typeof fetch });
    expect(String(firstCall(hunter)[0])).toContain("https://api.hunter.io/v2/account?api_key=");

    const custom = mockFetch(200);
    await testProviderKey("openai", SECRET, {
      fetchImpl: custom as unknown as typeof fetch,
      openaiBaseUrl: "https://proxy.example.com/v1/",
    });
    expect(firstCall(custom)[0]).toBe("https://proxy.example.com/v1/models");
  });

  it("returns unsupported where no safe check exists", async () => {
    for (const provider of ["pdl", "clearbit", "devto", "twitter"]) {
      const fetchImpl = mockFetch(200);
      const outcome = await testProviderKey(provider, SECRET, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(outcome.status).toBe("unsupported");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("rejects unknown providers", async () => {
    await expect(testProviderKey("nope", SECRET)).rejects.toThrow(VaultError);
  });
});
