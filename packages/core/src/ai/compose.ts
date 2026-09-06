import type { AiProvider } from "./types";
import { AiProviderError } from "./types";
import {
  buildOutreachMessages,
  TONE_VALUES,
  type ComposeOutreachInput,
  type OutreachTone,
} from "./prompt";
import { parseDraftResponse } from "./parser";

export interface OutreachDraft {
  subject: string;
  body: string;
  provider: string;
  model: string;
  tone: OutreachTone;
  generatedAt: string;
}

export const LIMITS = {
  context: 2000,
  purpose: 500,
  name: 200,
  company: 200,
  role: 200,
  email: 320,
} as const;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate and normalize compose input. Shared by the CLI and web route so
 * both enforce the same bounds (length caps per the Security & Auth
 * Architecture validation guidance, tone whitelist, and "some way to address
 * the recipient" requirement). Throws with an actionable message.
 */
export function validateComposeInput(
  input: ComposeOutreachInput,
): ComposeOutreachInput {
  const r = input.recipient;
  if (!r || (!r.name?.trim() && !r.email?.trim())) {
    throw new AiProviderError(
      "invalid_input",
      "A recipient name or email is required to draft an outreach message.",
    );
  }

  const tone = (input.tone ?? "professional") as OutreachTone;
  if (!TONE_VALUES.includes(tone)) {
    throw new AiProviderError(
      "invalid_input",
      `Unknown tone "${input.tone}". Expected one of: ${TONE_VALUES.join(", ")}.`,
    );
  }

  if (input.context && input.context.length > LIMITS.context) {
    throw new AiProviderError(
      "invalid_input",
      `Context must be ${LIMITS.context} characters or fewer.`,
    );
  }
  if (input.purpose && input.purpose.length > LIMITS.purpose) {
    throw new AiProviderError(
      "invalid_input",
      `Purpose must be ${LIMITS.purpose} characters or fewer.`,
    );
  }
  if (r.name && r.name.length > LIMITS.name) {
    throw new AiProviderError(
      "invalid_input",
      `Recipient name must be ${LIMITS.name} characters or fewer.`,
    );
  }
  if (r.company && r.company.length > LIMITS.company) {
    throw new AiProviderError(
      "invalid_input",
      `Company must be ${LIMITS.company} characters or fewer.`,
    );
  }
  if (r.role && r.role.length > LIMITS.role) {
    throw new AiProviderError(
      "invalid_input",
      `Role must be ${LIMITS.role} characters or fewer.`,
    );
  }
  if (r.email && r.email.trim() && !EMAIL_SHAPE.test(r.email.trim())) {
    throw new AiProviderError(
      "invalid_input",
      `"${r.email}" is not a valid email address.`,
    );
  }

  return { ...input, tone };
}

export interface ComposeDeps {
  provider: AiProvider;
  now?: Date;
}

/**
 * Compose an outreach draft: validate, prompt the provider, parse the reply
 * into subject + body. The provider is injected (never constructed here), so
 * callers own credential resolution and tests run fully offline.
 */
export async function composeOutreachMessage(
  input: ComposeOutreachInput,
  deps: ComposeDeps,
): Promise<OutreachDraft> {
  const normalized = validateComposeInput(input);
  const messages = buildOutreachMessages(normalized);

  const raw = await deps.provider.complete(messages, {
    model: normalized.model,
  });
  const parsed = parseDraftResponse(raw);

  return {
    subject: parsed.subject,
    body: parsed.body,
    provider: deps.provider.id,
    model: normalized.model ?? deps.provider.defaultModel,
    tone: normalized.tone ?? "professional",
    generatedAt: (deps.now ?? new Date()).toISOString(),
  };
}
