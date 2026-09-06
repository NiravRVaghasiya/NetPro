// AI outreach core: provider abstraction shared by the CLI (`netpro
// outreach`) and the web app (`POST /api/outreach`). The engine only ever
// drafts messages — NetPro never sends email — so this module is database
// free and network access is always injectable, keeping tests offline.

export type AiProviderId = 'openai' | 'anthropic';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletionOptions {
  /** Override the provider's default model. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AiProvider {
  id: AiProviderId;
  label: string;
  defaultModel: string;
  /** Send a chat completion and return the assistant's text reply. */
  complete(messages: ChatMessage[], options?: AiCompletionOptions): Promise<string>;
}

export interface ProviderConfig {
  apiKey: string;
  /** Override the API root (OpenAI-compatible endpoints, e.g. OpenRouter). */
  baseUrl?: string;
  /** Override the default model id. */
  model?: string;
}

/** Error codes the outreach engine can surface to CLI/web callers. */
export type AiErrorCode = 'not_configured' | 'upstream_error' | 'invalid_response' | 'invalid_input';

export class AiProviderError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
  }
}
