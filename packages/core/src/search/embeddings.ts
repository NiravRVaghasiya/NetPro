// packages/core/src/search/embeddings.ts
//
// The semantic arm's provider surface (v2.0 Phase 4).
//
// Posture, unchanged from `packages/core/ai`:
//   * plain `fetch`, no SDK dependency, `fetchImpl` injectable so every test
//     runs offline;
//   * bring-your-own key, read from the environment server-side (the CLI
//     keychain feeds the same shape) — never shipped to a browser;
//   * **disabled by default**. With no `EMBEDDINGS_PROVIDER` there is no
//     semantic arm, no network call, and search behaves exactly as v1.
//
// Vectors are persisted as JSON float arrays in `search_index.embedding`
// rather than a pgvector column. That keeps one producer for both dialects
// and keeps pgvector off the hard-dependency list (the plan's own risk row:
// "pgvector not available on a host"). Cosine similarity is brute-forced in
// JS over a bounded candidate set; a native `vector` column + HNSW index is a
// drop-in later optimization behind this same interface.
import type { SearchArmSkipReason } from "./types";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_BASE_URL = "https://api.openai.com/v1";
/** Providers reject oversized inputs; contact documents are short anyway. */
export const MAX_EMBEDDING_INPUT_CHARS = 8000;
/** Batch size for reindex runs — well inside every provider's array limit. */
export const EMBEDDING_BATCH_SIZE = 64;

export type EmbeddingsProviderId = "openai" | "disabled";

export interface EmbeddingsConfig {
  provider: EmbeddingsProviderId;
  apiKey?: string | null;
  model?: string | null;
  /** OpenAI-compatible API root (OpenRouter, LM Studio, a local gateway…). */
  baseUrl?: string | null;
  /** Optional output dimensionality, for models that support truncation. */
  dimensions?: number | null;
}

export class EmbeddingsError extends Error {
  readonly reason: SearchArmSkipReason;

  constructor(reason: SearchArmSkipReason, message: string) {
    super(message);
    this.name = "EmbeddingsError";
    this.reason = reason;
  }
}

export interface EmbeddingProvider {
  id: EmbeddingsProviderId;
  /** Model id stored alongside every vector — a model change invalidates the arm. */
  model: string;
  /** Embed a batch of documents, returning one vector per input, in order. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/**
 * Read the embeddings configuration out of an environment.
 *
 * Absent/blank/`disabled`/`none`/`off` all mean disabled. An explicitly
 * unknown provider is an error rather than a silent disable — a typo in
 * `EMBEDDINGS_PROVIDER` should be loud, not mysteriously keyword-only.
 */
export function resolveEmbeddingsConfig(
  env: Record<string, string | undefined> = process.env,
): EmbeddingsConfig {
  const raw = env.EMBEDDINGS_PROVIDER?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "disabled" || raw === "none" || raw === "off") {
    return { provider: "disabled" };
  }
  if (raw !== "openai") {
    throw new EmbeddingsError(
      "not_configured",
      `Unknown EMBEDDINGS_PROVIDER "${env.EMBEDDINGS_PROVIDER}". Expected "openai" or "disabled".`,
    );
  }

  const dimensions = env.EMBEDDINGS_DIMENSIONS?.trim();
  const parsedDims = dimensions ? Number(dimensions) : null;
  if (
    parsedDims !== null &&
    (!Number.isInteger(parsedDims) || parsedDims < 8 || parsedDims > 4096)
  ) {
    throw new EmbeddingsError(
      "not_configured",
      `EMBEDDINGS_DIMENSIONS must be an integer between 8 and 4096, got "${dimensions}".`,
    );
  }

  return {
    provider: "openai",
    apiKey: env.EMBEDDINGS_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || null,
    model: env.EMBEDDINGS_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
    baseUrl:
      env.EMBEDDINGS_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || null,
    dimensions: parsedDims,
  };
}

/** Is a semantic arm even possible with this config? Never throws. */
export function embeddingsEnabled(config: EmbeddingsConfig): boolean {
  return config.provider === "openai" && Boolean(config.apiKey);
}

/**
 * Build a provider, or `null` when embeddings are not configured. Returning
 * null (rather than throwing) is what lets every caller treat "no key" as a
 * skipped arm instead of an error path.
 */
export function createEmbeddingProvider(
  config: EmbeddingsConfig,
  fetchImpl: typeof fetch = fetch,
): EmbeddingProvider | null {
  if (!embeddingsEnabled(config)) return null;

  const baseUrl = (config.baseUrl ?? DEFAULT_EMBEDDING_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const model = config.model ?? DEFAULT_EMBEDDING_MODEL;
  const apiKey = config.apiKey as string;

  return {
    id: "openai",
    model,
    async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
      if (texts.length === 0) return [];
      const input = texts.map((t) =>
        t.slice(0, MAX_EMBEDDING_INPUT_CHARS).trim(),
      );

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input,
            ...(config.dimensions ? { dimensions: config.dimensions } : {}),
          }),
          signal,
        });
      } catch (error) {
        // Network failure must never be fatal to a search request.
        throw new EmbeddingsError(
          "provider_error",
          `Embeddings request failed: ${(error as Error).message}`,
        );
      }

      if (!response.ok) {
        throw new EmbeddingsError(
          "provider_error",
          `Embeddings request failed: ${response.status}${await extractError(response)}`,
        );
      }

      const json = (await response.json().catch(() => null)) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      } | null;
      const data = json?.data;
      if (!Array.isArray(data) || data.length !== input.length) {
        throw new EmbeddingsError(
          "provider_error",
          `Embeddings response had ${data?.length ?? 0} vectors for ${input.length} inputs.`,
        );
      }

      // The API documents `index`, but ordering is only guaranteed once you
      // honour it — sort defensively before mapping back onto the inputs.
      const ordered = [...data].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      return ordered.map((row, i) => {
        const vector = row.embedding;
        if (!Array.isArray(vector) || vector.length === 0) {
          throw new EmbeddingsError(
            "provider_error",
            `Embeddings response vector ${i} was empty.`,
          );
        }
        return vector;
      });
    },
  };
}

async function extractError(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as { error?: { message?: string } };
    return json.error?.message ? ` ${json.error.message}` : "";
  } catch {
    return "";
  }
}

// ── Vector helpers (pure) ────────────────────────────────────────────────

/**
 * Serialize a vector for `search_index.embedding`.
 *
 * Rounded to 6 decimals: embedding APIs return ~17 significant digits, which
 * triples the stored size for precision far below what cosine ranking can
 * distinguish (the 7th decimal moves a 1536-dim cosine by < 1e-6).
 */
export function encodeEmbedding(vector: number[]): string {
  return JSON.stringify(vector.map((v) => Math.round(v * 1e6) / 1e6));
}

/** Parse a stored vector; returns null for absent/corrupt values (never throws). */
export function decodeEmbedding(value: string | null | undefined): number[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const out = new Array<number>(parsed.length);
    for (let i = 0; i < parsed.length; i++) {
      const n = parsed[i];
      if (typeof n !== "number" || !Number.isFinite(n)) return null;
      out[i] = n;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Cosine similarity in [-1, 1]; 0 for a zero vector or a length mismatch
 * (a mismatch means the row was embedded with a different model — it must not
 * throw mid-query, it must simply not rank).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
