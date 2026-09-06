import { NextResponse } from "next/server";
import { conn } from "@/lib/db";
import {
  composeOutreachMessage,
  resolveAiProvider,
  getContactById,
  contactToRecipientInput,
  TONE_VALUES,
  validateComposeInput,
  AiProviderError,
  type ComposeOutreachInput,
  type OutreachTone,
  type RecipientInput,
} from "@netpro/core/src/ai";

const LIMITS = { context: 2000, purpose: 500, name: 200, company: 200, role: 200 };

interface OutreachRequestBody {
  contactId?: unknown;
  recipient?: {
    name?: unknown;
    email?: unknown;
    company?: unknown;
    role?: unknown;
  };
  context?: unknown;
  purpose?: unknown;
  tone?: unknown;
  sender?: unknown;
  provider?: unknown;
  model?: unknown;
}

function str(value: unknown, max: number, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`"${field}" must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new Error(`"${field}" must be ${max} characters or fewer`);
  }
  return trimmed || undefined;
}

/** Read AI credentials from the server environment (host-configured BYO key). */
function credentialsFromEnv(explicitProvider?: string) {
  const provider = explicitProvider ?? process.env.AI_PROVIDER;
  const model =
    process.env.AI_MODEL ??
    (provider === "anthropic" ? process.env.ANTHROPIC_MODEL : process.env.OPENAI_MODEL);
  return {
    provider,
    openaiKey: process.env.OPENAI_API_KEY ?? null,
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? null,
    model: model || undefined,
  };
}

export async function POST(request: Request) {
  let body: OutreachRequestBody;
  try {
    body = (await request.json()) as OutreachRequestBody;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  try {
    const tone = body.tone === undefined || body.tone === null ? "professional" : body.tone;
    if (typeof tone !== "string" || !TONE_VALUES.includes(tone as OutreachTone)) {
      return NextResponse.json(
        { error: `Invalid tone — expected one of: ${TONE_VALUES.join(", ")}` },
        { status: 400 },
      );
    }

    const provider =
      body.provider === undefined || body.provider === null
        ? undefined
        : str(body.provider, 20, "provider");
    if (provider && provider !== "openai" && provider !== "anthropic") {
      return NextResponse.json(
        { error: 'Invalid provider — expected "openai" or "anthropic"' },
        { status: 400 },
      );
    }

    // Resolve the recipient: a stored contact id, or an ad-hoc recipient.
    let recipient: RecipientInput;
    const contactId = str(body.contactId, 100, "contactId");
    if (contactId) {
      const ref = await getContactById(conn, contactId);
      if (!ref) {
        return NextResponse.json(
          { error: `No contact found with id "${contactId}"` },
          { status: 400 },
        );
      }
      recipient = contactToRecipientInput(ref);
    } else if (body.recipient && typeof body.recipient === "object") {
      recipient = {
        name: str(body.recipient.name, LIMITS.name, "recipient.name"),
        email: str(body.recipient.email, 320, "recipient.email"),
        company: str(body.recipient.company, LIMITS.company, "recipient.company"),
        role: str(body.recipient.role, LIMITS.role, "recipient.role"),
      };
    } else {
      return NextResponse.json(
        { error: 'Provide "contactId" or a "recipient" object' },
        { status: 400 },
      );
    }

    const model = str(body.model, 100, "model");
    const input = validateComposeInput({
      recipient,
      senderName: str(body.sender, LIMITS.name, "sender"),
      tone: tone as OutreachTone,
      context: str(body.context, LIMITS.context, "context"),
      purpose: str(body.purpose, LIMITS.purpose, "purpose"),
      provider: provider as ComposeOutreachInput["provider"],
      model,
    });

    const aiProvider = resolveAiProvider(credentialsFromEnv(provider));
    const draft = await composeOutreachMessage(input, { provider: aiProvider });
    return NextResponse.json(draft);
  } catch (error) {
    if (error instanceof AiProviderError) {
      if (error.code === "not_configured") {
        return NextResponse.json(
          { error: error.message, code: "ai_not_configured" },
          { status: 500 },
        );
      }
      if (error.code === "invalid_input") {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      // upstream_error / invalid_response from the model call both mean the
      // provider interaction failed; the UI surfaces the message.
      return NextResponse.json(
        { error: error.message, code: "ai_upstream_error" },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
