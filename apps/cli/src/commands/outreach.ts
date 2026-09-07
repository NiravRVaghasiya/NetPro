import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  composeOutreachMessage,
  resolveAiProvider,
  resolveContactRef,
  contactToRecipientInput,
  TONE_VALUES,
  validateComposeInput,
  type ComposeOutreachInput,
  type OutreachDraft,
  type OutreachTone,
  type RecipientInput,
} from "@netpro/core/src/ai";
import { Keychain } from "../config/keychain";

export interface OutreachCommandOptions {
  // Recipient from the database:
  to?: string;
  // Ad-hoc recipient (not in contacts):
  email?: string;
  name?: string;
  company?: string;
  role?: string;
  // Draft parameters:
  context?: string;
  purpose?: string;
  tone?: string;
  sender?: string;
  provider?: string;
  model?: string;
  json?: boolean;
}

export interface OutreachExecutionInput {
  /** Selector for a contact in the database, or undefined for ad-hoc. */
  selector?: string;
  adHoc?: RecipientInput;
  compose: Omit<ComposeOutreachInput, "recipient">;
}

/**
 * Map and validate CLI flags into the core compose input (recipient
 * resolution happens later, against the database). `--to` is mutually
 * exclusive with the ad-hoc recipient flags.
 */
export function toOutreachInput(
  opts: OutreachCommandOptions,
): OutreachExecutionInput {
  const tone = (opts.tone ?? "professional") as OutreachTone;
  if (!TONE_VALUES.includes(tone)) {
    throw new Error(
      `Unknown --tone "${opts.tone}". Expected one of: ${TONE_VALUES.join(", ")}.`,
    );
  }

  const adHocFlags = [opts.email, opts.name, opts.company, opts.role].filter(
    (v): v is string => Boolean(v && v.trim()),
  );

  let selector: string | undefined;
  let adHoc: RecipientInput | undefined;

  if (opts.to) {
    if (adHocFlags.length > 0) {
      throw new Error(
        "--to picks a contact from your database and cannot be combined with --email/--name/--company/--role.",
      );
    }
    selector = opts.to.trim();
  } else if (adHocFlags.length > 0) {
    adHoc = {
      email: opts.email?.trim() || undefined,
      name: opts.name?.trim() || undefined,
      company: opts.company?.trim() || undefined,
      role: opts.role?.trim() || undefined,
    };
  } else {
    throw new Error(
      "Provide a recipient: --to <email|id|name> for one of your contacts, or ad-hoc --name/--email/--company/--role.",
    );
  }

  return {
    selector,
    adHoc,
    compose: {
      senderName: opts.sender?.trim() || undefined,
      tone,
      context: opts.context?.trim() || undefined,
      purpose: opts.purpose?.trim() || undefined,
      provider: opts.provider as ComposeOutreachInput["provider"],
      model: opts.model?.trim() || undefined,
    },
  };
}

/** Best-effort git user name, used as the sender when nothing is configured. */
function gitUserName(): string | undefined {
  try {
    const out = execFileSync("git", ["config", "user.name"], {
      encoding: "utf-8",
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read AI credentials from the encrypted keychain with env fallbacks.
 * Exported for `netpro path --draft` (v2.0 Phase 3) — both draft-only AI
 * surfaces must resolve credentials identically.
 */
export async function readCredentials(providerFlag?: string) {
  const [keychainProvider, openaiKey, anthropicKey] = await Promise.all([
    Keychain.get("ai.provider"),
    Keychain.get("ai.openai.key"),
    Keychain.get("ai.anthropic.key"),
  ]);
  const senderKeychain = await Keychain.get("user.name");

  const provider =
    providerFlag?.trim() || process.env.AI_PROVIDER || keychainProvider;
  return {
    credentials: {
      provider,
      openaiKey: process.env.OPENAI_API_KEY || openaiKey,
      anthropicKey: process.env.ANTHROPIC_API_KEY || anthropicKey,
      openaiBaseUrl: process.env.OPENAI_BASE_URL || null,
      model:
        process.env.AI_MODEL ||
        (provider === "anthropic"
          ? process.env.ANTHROPIC_MODEL
          : process.env.OPENAI_MODEL) ||
        null,
    },
    sender: senderKeychain?.trim() || gitUserName(),
  };
}

export async function executeOutreach(
  opts: OutreachCommandOptions,
  conn: SqliteConn | PgConn,
): Promise<string> {
  const input = toOutreachInput(opts);

  let recipient: RecipientInput;
  if (input.selector) {
    const ref = await resolveContactRef(conn, input.selector);
    recipient = contactToRecipientInput(ref);
  } else {
    recipient = input.adHoc!;
  }

  const { credentials, sender } = await readCredentials(input.compose.provider);
  const provider = resolveAiProvider(credentials);

  const composeInput = validateComposeInput({
    ...input.compose,
    recipient,
    senderName: input.compose.senderName ?? sender,
    model: input.compose.model ?? credentials.model ?? undefined,
  });

  const draft: OutreachDraft = await composeOutreachMessage(composeInput, {
    provider,
  });

  if (opts.json) {
    return JSON.stringify(draft, null, 2);
  }
  return `Subject: ${draft.subject}\n\n${draft.body}\n\n— drafted via NetPro (${draft.provider}/${draft.model}); review and send yourself.`;
}

export function registerOutreachCommand(program: Command): void {
  program
    .command("outreach")
    .description(
      "Draft an AI-composed outreach message (NetPro drafts — you send)",
    )
    .option(
      "--to <email|id|name>",
      "recipient from your contacts (exact email/id or unique full name)",
    )
    .option(
      "--email <email>",
      "ad-hoc recipient email (for someone not in your contacts)",
    )
    .option("--name <name>", "ad-hoc recipient name")
    .option("--company <company>", "ad-hoc recipient company")
    .option("--role <role>", "ad-hoc recipient role")
    .option("--context <text>", "context for why you are reaching out")
    .option(
      "--purpose <text>",
      'the ask, e.g. "a 15-minute call about OSS collab"',
    )
    .option("--tone <tone>", `tone: ${TONE_VALUES.join(" | ")}`, "professional")
    .option(
      "--sender <name>",
      "your name for the sign-off (default: config user.name → git)",
    )
    .option(
      "--provider <provider>",
      "openai | anthropic (default: keychain ai.provider / AI_PROVIDER)",
    )
    .option("--model <model-id>", "override the provider default model")
    .option("--json", "emit the draft as JSON")
    .action(async (options: OutreachCommandOptions) => {
      const { openDb } = await import("../db");
      try {
        const output = await executeOutreach(options, await openDb());
        console.log(output);
      } catch (e) {
        console.error(`netpro outreach: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
