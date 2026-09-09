import { privateEmbedder } from './provider-privacy';
// apps/web/lib/search-config.ts
//
// Server-side resolution of the hybrid-search feature gate (v2.0 Phase 4).
//
// The embeddings key is read from the server environment and never leaves it:
// pages get a boolean ("is the semantic toggle even meaningful here?"), API
// routes get a provider object, and the browser gets neither. Same posture as
// the AI outreach credentials — BYO key, host-configured, server-only.
import {
  createEmbeddingProvider,
  embeddingsEnabled,
  resolveEmbeddingsConfig,
  type EmbeddingProvider,
  type EmbeddingsConfig,
} from "@netpro/core/src/search";

/**
 * Read the config, treating a misconfiguration as "off".
 *
 * A typo in `EMBEDDINGS_PROVIDER` throws inside the core resolver (loud is
 * right for the CLI, where a human is watching). On a web request the right
 * answer is to degrade: search must not 500 because an env var is misspelled.
 */
export function searchEmbeddingsConfig(
  env: Record<string, string | undefined> = process.env,
): EmbeddingsConfig {
  try {
    return resolveEmbeddingsConfig(env);
  } catch {
    return { provider: "disabled" };
  }
}

/** Should the UI offer a semantic toggle at all? */
export function semanticSearchAvailable(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return embeddingsEnabled(searchEmbeddingsConfig(env));
}

/** The provider for the semantic arm, or null when not configured. */
export function searchEmbedder(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider | null {
  return privateEmbedder(createEmbeddingProvider(searchEmbeddingsConfig(env)));
}
