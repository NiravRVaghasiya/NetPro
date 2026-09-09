import { AiProviderError, type AiProvider } from "@netpro/core/src/ai";
import {
  EmbeddingsError,
  type EmbeddingProvider,
} from "@netpro/core/src/search";
import type { EnrichmentProvider } from "@netpro/core/src/enrichment";

// External error bodies (including network errors containing request URLs)
// can echo credentials. In the web app those may belong to another principal.
// Replace errors before core code can store/return them in per-contact summaries.
export function privateAiProvider(provider: AiProvider): AiProvider {
  return {
    ...provider,
    async complete(...args) {
      try {
        return await provider.complete(...args);
      } catch {
        throw new AiProviderError(
          "upstream_error",
          "AI provider request failed. Check credentials and provider availability.",
        );
      }
    },
  };
}
export function privateEmbedder(
  provider: EmbeddingProvider | null,
): EmbeddingProvider | null {
  if (!provider) return null;
  return {
    ...provider,
    async embed(...args) {
      try {
        return await provider.embed(...args);
      } catch {
        throw new EmbeddingsError(
          "provider_error",
          "Embedding provider request failed.",
        );
      }
    },
  };
}
export function privateEnrichmentProvider(
  provider: EnrichmentProvider,
): EnrichmentProvider {
  return {
    ...provider,
    async enrich(...args) {
      try {
        return await provider.enrich(...args);
      } catch {
        throw new Error(
          "Enrichment provider request failed. Check credentials and provider availability.",
        );
      }
    },
  };
}
