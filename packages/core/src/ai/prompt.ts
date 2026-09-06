import type { ChatMessage } from "./types";

export const TONE_VALUES = [
  "professional",
  "warm",
  "casual",
  "friendly",
] as const;
export type OutreachTone = (typeof TONE_VALUES)[number];

export interface RecipientInput {
  name?: string;
  email?: string;
  company?: string;
  role?: string;
  headline?: string;
  location?: string;
  industry?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  notes?: string;
}

export interface ComposeOutreachInput {
  recipient: RecipientInput;
  senderName?: string;
  tone?: OutreachTone;
  /** Free-text context for the outreach, e.g. "met at React Conf after your WASM talk". */
  context?: string;
  /** The ask, e.g. "a 15-minute call about OSS collaboration". */
  purpose?: string;
  provider?: "openai" | "anthropic";
  model?: string;
}

const SYSTEM_PROMPT = [
  "You are a professional networking assistant that writes concise, personalized outreach messages.",
  "Rules:",
  "- Use ONLY the facts provided. Never invent meetings, conversations, shared contacts, talks, posts, or compliments.",
  "- Keep the message short (3–6 sentences) with one clear, low-friction ask.",
  "- Match the requested tone. Be specific and human; avoid generic flattery and spammy phrasing",
  '  (no "act now", "guaranteed", or pressure language).',
  "- Do not mention that you are an AI.",
  "- Sign off with the sender's name when it is provided.",
  '- Respond with ONLY a JSON object: {"subject":"...","body":"..."}. No markdown, no commentary.',
].join("\n");

/**
 * Build the system + user chat messages for an outreach draft. Pure and
 * deterministic — unknown/empty recipient fields are simply omitted so the
 * model cannot hallucinate around them.
 */
export function buildOutreachMessages(
  input: ComposeOutreachInput,
): ChatMessage[] {
  const r = input.recipient;
  const facts: Array<[string, string]> = [];
  if (r.name) facts.push(["Name", r.name]);
  if (r.role) facts.push(["Role", r.role]);
  if (r.company) facts.push(["Company", r.company]);
  if (r.headline) facts.push(["Headline", r.headline]);
  if (r.industry) facts.push(["Industry", r.industry]);
  if (r.location) facts.push(["Location", r.location]);
  if (r.email) facts.push(["Email", r.email]);
  if (r.linkedinUrl) facts.push(["LinkedIn", r.linkedinUrl]);
  if (r.githubUrl) facts.push(["GitHub", r.githubUrl]);
  if (r.notes) facts.push(["Existing notes", r.notes]);

  const lines: string[] = ["Write one outreach message to this person:"];
  if (facts.length > 0) {
    lines.push("");
    for (const [label, value] of facts) lines.push(`- ${label}: ${value}`);
  } else {
    lines.push(
      "- (No profile details are available — keep the greeting generic and do not assume any facts.)",
    );
  }

  lines.push("");
  lines.push(`- Tone: ${input.tone ?? "professional"}`);
  if (input.senderName) lines.push(`- Sign off as: ${input.senderName}`);
  if (input.context)
    lines.push(`- Context for why I'm reaching out: ${input.context}`);
  if (input.purpose) lines.push(`- The ask: ${input.purpose}`);

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n") },
  ];
}
