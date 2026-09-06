import { AiProviderError } from './types';

export interface ParsedDraft {
  subject: string;
  body: string;
}

/**
 * Extract subject/body from a model completion. Accepts, in order:
 *   1. a raw JSON object {"subject","body"} (possibly with surrounding prose);
 *   2. a ```json-fenced code block containing that object;
 *   3. plain text starting with a "Subject:" line, blank line, then body.
 * Throws `invalid_response` when none parse into non-empty fields.
 */
export function parseDraftResponse(raw: string): ParsedDraft {
  const text = raw.trim();

  const fromJson = tryParseJson(text);
  if (fromJson) return fromJson;

  const fromFence = tryParseFencedJson(text);
  if (fromFence) return fromFence;

  const fromPlain = tryParsePlainText(text);
  if (fromPlain) return fromPlain;

  throw new AiProviderError(
    'invalid_response',
    'AI provider returned a response that could not be parsed into a subject and body',
  );
}

function cleanFields(value: unknown): ParsedDraft | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const subject = typeof v.subject === 'string' ? v.subject.trim() : '';
  const body = typeof v.body === 'string' ? v.body.trim() : '';
  if (!subject || !body) return null;
  return { subject, body };
}

function tryParseJson(text: string): ParsedDraft | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return cleanFields(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

function tryParseFencedJson(text: string): ParsedDraft | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!match) return null;
  return tryParseJson(match[1]!.trim());
}

function tryParsePlainText(text: string): ParsedDraft | null {
  const match = text.match(/^\s*subject\s*:\s*(.+?)\s*\n\s*\n([\s\S]+)$/i);
  if (!match) return null;
  const subject = match[1]!.trim();
  const body = match[2]!.trim();
  if (!subject || !body) return null;
  return { subject, body };
}
