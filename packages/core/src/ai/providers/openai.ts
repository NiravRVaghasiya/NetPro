import type {
  AiCompletionOptions,
  AiProvider,
  ChatMessage,
  ProviderConfig,
} from "../types";
import { AiProviderError } from "../types";

export const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

type FetchImpl = typeof fetch;

/**
 * OpenAI-compatible Chat Completions provider. Works against OpenAI itself
 * and any compatible endpoint (OpenRouter, local servers) via `baseUrl`.
 * Uses global `fetch` — no SDK dependency, mirroring the enrichment
 * providers. `fetchImpl` is injectable for offline tests.
 */
export function createOpenAiProvider(
  config: ProviderConfig,
  fetchImpl: FetchImpl = fetch,
): AiProvider {
  const baseUrl = (config.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const defaultModel = config.model ?? OPENAI_DEFAULT_MODEL;

  return {
    id: "openai",
    label: "OpenAI",
    defaultModel,

    async complete(
      messages: ChatMessage[],
      options?: AiCompletionOptions,
    ): Promise<string> {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: options?.model ?? defaultModel,
          messages,
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? 600,
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        throw new AiProviderError(
          "upstream_error",
          `OpenAI request failed: ${response.status}${await extractError(response)}`,
        );
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new AiProviderError(
          "invalid_response",
          "OpenAI returned an empty completion",
        );
      }
      return content;
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
