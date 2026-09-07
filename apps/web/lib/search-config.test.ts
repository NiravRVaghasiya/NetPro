import { describe, expect, it } from "vitest";
import {
  searchEmbedder,
  searchEmbeddingsConfig,
  semanticSearchAvailable,
} from "./search-config";

describe("search-config", () => {
  it("is disabled with no configuration — the default deployment", () => {
    expect(searchEmbeddingsConfig({})).toEqual({ provider: "disabled" });
    expect(semanticSearchAvailable({})).toBe(false);
    expect(searchEmbedder({})).toBeNull();
  });

  it("enables the semantic arm when a key is present", () => {
    const env = {
      EMBEDDINGS_PROVIDER: "openai",
      EMBEDDINGS_API_KEY: "sk-test",
    };
    expect(semanticSearchAvailable(env)).toBe(true);
    expect(searchEmbedder(env)?.model).toBe("text-embedding-3-small");
  });

  it("is not available when the provider is named but the key is missing", () => {
    const env = { EMBEDDINGS_PROVIDER: "openai" };
    expect(semanticSearchAvailable(env)).toBe(false);
    expect(searchEmbedder(env)).toBeNull();
  });

  it("degrades instead of throwing on a misconfigured provider name", () => {
    // The CLI throws here (a human is watching); a web request must not 500
    // because an env var was misspelled.
    const env = { EMBEDDINGS_PROVIDER: "openia" };
    expect(searchEmbeddingsConfig(env)).toEqual({ provider: "disabled" });
    expect(semanticSearchAvailable(env)).toBe(false);
  });

  it("degrades instead of throwing on invalid dimensions", () => {
    const env = {
      EMBEDDINGS_PROVIDER: "openai",
      EMBEDDINGS_API_KEY: "sk-test",
      EMBEDDINGS_DIMENSIONS: "1e9",
    };
    expect(semanticSearchAvailable(env)).toBe(false);
  });

  it("honours a custom model and base url", () => {
    const provider = searchEmbedder({
      EMBEDDINGS_PROVIDER: "openai",
      EMBEDDINGS_API_KEY: "sk-test",
      EMBEDDINGS_MODEL: "text-embedding-3-large",
      EMBEDDINGS_BASE_URL: "https://gw.example/v1",
    });
    expect(provider?.model).toBe("text-embedding-3-large");
  });

  it("falls back to the outreach OPENAI_API_KEY when EMBEDDINGS_API_KEY is absent", () => {
    const env = {
      EMBEDDINGS_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-shared",
    };
    expect(semanticSearchAvailable(env)).toBe(true);
  });

  it("stays disabled when only OPENAI_API_KEY is set — embeddings are opt-in", () => {
    // Having an outreach key must not silently start billing embedding calls.
    expect(semanticSearchAvailable({ OPENAI_API_KEY: "sk-shared" })).toBe(
      false,
    );
  });
});
