// packages/core/src/ai
//
// AI outreach drafting engine: provider abstraction (OpenAI-compatible +
// Anthropic over raw fetch), BYO-key credential resolution, prompt
// construction, draft parsing, and the compose entry point. Shared by the
// CLI (`netpro outreach`) and the web app (`POST /api/outreach`).
export * from './types';
export { createOpenAiProvider, OPENAI_DEFAULT_MODEL, OPENAI_DEFAULT_BASE_URL } from './providers/openai';
export {
  createAnthropicProvider,
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_API_URL,
  ANTHROPIC_API_VERSION,
} from './providers/anthropic';
export * from './credentials';
export * from './prompt';
export * from './parser';
export * from './compose';
export * from './resolve-contact';
