import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_EMBEDDING_MODEL,
  EmbeddingsError,
  MAX_EMBEDDING_INPUT_CHARS,
  cosineSimilarity,
  createEmbeddingProvider,
  decodeEmbedding,
  embeddingsEnabled,
  encodeEmbedding,
  resolveEmbeddingsConfig,
} from "./embeddings";

/** Minimal OpenAI-shaped embeddings response. */
/** vi.fn() with an explicit fetch-shaped signature, so mock.calls stays typed. */
type FetchMock = (input: string, init: RequestInit) => Promise<Response>;

function ok(vectors: number[][], extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ embedding, index })),
      ...extra,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("resolveEmbeddingsConfig", () => {
  it("is disabled with no configuration at all", () => {
    const config = resolveEmbeddingsConfig({});
    expect(config).toEqual({ provider: "disabled" });
    expect(embeddingsEnabled(config)).toBe(false);
  });

  it.each(["", "  ", "disabled", "DISABLED", "none", "off"])(
    "treats %j as disabled",
    (value) => {
      expect(
        resolveEmbeddingsConfig({ EMBEDDINGS_PROVIDER: value }).provider,
      ).toBe("disabled");
    },
  );

  it("throws on a typo rather than silently disabling", () => {
    expect(() =>
      resolveEmbeddingsConfig({ EMBEDDINGS_PROVIDER: "openai " + "x" }),
    ).toThrow(/Unknown EMBEDDINGS_PROVIDER/);
  });

  it("reads keys, model and base url, defaulting the model", () => {
    const config = resolveEmbeddingsConfig({
      EMBEDDINGS_PROVIDER: "openai",
      EMBEDDINGS_API_KEY: " sk-test ",
      EMBEDDINGS_BASE_URL: "https://gw.example/v1",
    });
    expect(config).toEqual({
      provider: "openai",
      apiKey: "sk-test",
      model: DEFAULT_EMBEDDING_MODEL,
      baseUrl: "https://gw.example/v1",
      dimensions: null,
    });
    expect(embeddingsEnabled(config)).toBe(true);
  });

  it("falls back to the outreach OPENAI_* variables", () => {
    const config = resolveEmbeddingsConfig({
      EMBEDDINGS_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-shared",
      OPENAI_BASE_URL: "https://proxy.example/v1",
    });
    expect(config.apiKey).toBe("sk-shared");
    expect(config.baseUrl).toBe("https://proxy.example/v1");
  });

  it("is configured-but-unusable without a key", () => {
    const config = resolveEmbeddingsConfig({ EMBEDDINGS_PROVIDER: "openai" });
    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBeNull();
    expect(embeddingsEnabled(config)).toBe(false);
    expect(createEmbeddingProvider(config)).toBeNull();
  });

  it.each(["0", "4", "5000", "1.5", "abc"])(
    "rejects out-of-range dimensions %j",
    (value) => {
      expect(() =>
        resolveEmbeddingsConfig({
          EMBEDDINGS_PROVIDER: "openai",
          EMBEDDINGS_API_KEY: "k",
          EMBEDDINGS_DIMENSIONS: value,
        }),
      ).toThrow(EmbeddingsError);
    },
  );
});

describe("createEmbeddingProvider", () => {
  const config = {
    provider: "openai" as const,
    apiKey: "sk-test",
    model: "text-embedding-3-small",
  };

  it("posts to /embeddings with the model and bearer key", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => ok([[1, 0, 0]]));
    const provider = createEmbeddingProvider(config, fetchImpl as unknown as typeof fetch)!;
    const vectors = await provider.embed(["hello"]);

    expect(vectors).toEqual([[1, 0, 0]]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: "text-embedding-3-small", input: ["hello"] });
  });

  it("strips a trailing slash from a custom base url and sends dimensions", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => ok([[0.5, 0.5]]));
    const provider = createEmbeddingProvider(
      { ...config, baseUrl: "https://gw.example/v1//", dimensions: 256 },
      fetchImpl as unknown as typeof fetch,
    )!;
    await provider.embed(["hi"]);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://gw.example/v1/embeddings");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string).dimensions).toBe(256);
  });

  it("never calls the network for an empty batch", async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    const provider = createEmbeddingProvider(config, fetchImpl as unknown as typeof fetch)!;
    expect(await provider.embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("truncates oversized inputs instead of letting the provider reject them", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => ok([[1]]));
    const provider = createEmbeddingProvider(config, fetchImpl as unknown as typeof fetch)!;
    await provider.embed(["x".repeat(MAX_EMBEDDING_INPUT_CHARS + 500)]);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.input[0]).toHaveLength(MAX_EMBEDDING_INPUT_CHARS);
  });

  it("reorders the response by `index` before mapping back onto inputs", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { embedding: [2], index: 1 },
              { embedding: [1], index: 0 },
            ],
          }),
          { status: 200 },
        ),
    );
    const provider = createEmbeddingProvider(config, fetchImpl as unknown as typeof fetch)!;
    expect(await provider.embed(["a", "b"])).toEqual([[1], [2]]);
  });

  it("surfaces an HTTP error with the provider's message", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
          status: 429,
        }),
    );
    const provider = createEmbeddingProvider(config, fetchImpl as unknown as typeof fetch)!;
    await expect(provider.embed(["a"])).rejects.toThrow(/429 quota exceeded/);
    await expect(provider.embed(["a"])).rejects.toBeInstanceOf(EmbeddingsError);
  });

  it("turns a transport failure into an EmbeddingsError, not a raw TypeError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const provider = createEmbeddingProvider(config, fetchImpl as unknown as typeof fetch)!;
    const error = await provider.embed(["a"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingsError);
    expect((error as EmbeddingsError).reason).toBe("provider_error");
  });

  it("rejects a response with the wrong number of vectors", async () => {
    const fetchImpl = vi.fn(async () => ok([[1]]));
    const provider = createEmbeddingProvider(config, fetchImpl as unknown as typeof fetch)!;
    await expect(provider.embed(["a", "b"])).rejects.toThrow(/1 vectors for 2 inputs/);
  });

  it("rejects an empty vector", async () => {
    const fetchImpl = vi.fn(async () => ok([[]]));
    const provider = createEmbeddingProvider(config, fetchImpl as unknown as typeof fetch)!;
    await expect(provider.embed(["a"])).rejects.toThrow(/vector 0 was empty/);
  });
});

describe("vector helpers", () => {
  it("round-trips a vector, rounding to 6 decimals", () => {
    const encoded = encodeEmbedding([0.1234567891, -0.5, 1]);
    expect(encoded).toBe("[0.123457,-0.5,1]");
    expect(decodeEmbedding(encoded)).toEqual([0.123457, -0.5, 1]);
  });

  it.each([null, undefined, "", "not json", "{}", "[]", '[1,"a"]', "[1,null]"])(
    "decodes %j to null instead of throwing",
    (value) => {
      expect(decodeEmbedding(value as string | null)).toBeNull();
    },
  );

  it("scores identical vectors 1 and orthogonal vectors 0", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
  });

  it("is scale invariant", () => {
    expect(cosineSimilarity([1, 1], [10, 10])).toBeCloseTo(1, 12);
  });

  it("returns 0 for a dimension mismatch or a zero vector", () => {
    // A mismatch means the row was embedded with another model — it must not
    // rank, and it must not throw mid-query.
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});
