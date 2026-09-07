// packages/core/src/campaigns/template.ts
//
// Merge-variable templating: `{{firstName}}`-style placeholders resolved per
// recipient from the contact row (with per-recipient overrides). A whitelist
// plus plain string replacement instead of a template engine — no new
// dependency, no code execution, and unknown variables fail at save time so
// a typo never reaches someone's inbox as a blank stare.

import { CrmError } from '../crm/types';
import {
  CAMPAIGN_LIMITS,
  TEMPLATE_VARIABLES,
  type DripStep,
  type MessageTemplate,
  type TemplateVariable,
} from './types';

const VARIABLE_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/** Every `{{variable}}` name used in a text, in order of appearance, deduped. */
export function extractTemplateVariables(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(VARIABLE_RE)) found.add(match[1]!);
  return [...found];
}

function assertKnownVariables(text: string, field: string): void {
  const unknown = extractTemplateVariables(text).filter(
    (name) => !TEMPLATE_VARIABLES.includes(name as TemplateVariable)
  );
  if (unknown.length > 0) {
    throw new CrmError(
      'invalid_input',
      `Unknown merge variable${unknown.length === 1 ? '' : 's'} in ${field}: ${unknown
        .map((u) => `{{${u}}}`)
        .join(', ')}. Available: ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(', ')}.`
    );
  }
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CrmError('invalid_input', `${field} is required and must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new CrmError('invalid_input', `${field} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

/** Validate one {subject, body} message; returns the normalized template. */
export function validateMessageTemplate(input: unknown, label = 'template'): MessageTemplate {
  if (typeof input !== 'object' || input === null) {
    throw new CrmError('invalid_input', `${label} must be an object with "subject" and "body".`);
  }
  const raw = input as { subject?: unknown; body?: unknown };
  const subject = requireText(raw.subject, `${label}.subject`, CAMPAIGN_LIMITS.subject);
  const body = requireText(raw.body, `${label}.body`, CAMPAIGN_LIMITS.body);
  assertKnownVariables(subject, `${label}.subject`);
  assertKnownVariables(body, `${label}.body`);
  return { subject, body };
}

/** Validate the drip sequence (≤5 steps, delayDays 1–365, same message rules). */
export function validateDripSteps(input: unknown): DripStep[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new CrmError('invalid_input', 'steps must be an array of drip steps.');
  }
  if (input.length > CAMPAIGN_LIMITS.steps) {
    throw new CrmError(
      'invalid_input',
      `A campaign supports at most ${CAMPAIGN_LIMITS.steps} drip steps.`
    );
  }
  return input.map((step, i) => {
    if (typeof step !== 'object' || step === null) {
      throw new CrmError('invalid_input', `steps[${i}] must be an object.`);
    }
    const raw = step as { delayDays?: unknown; subject?: unknown; body?: unknown };
    const delay = raw.delayDays;
    if (
      typeof delay !== 'number' ||
      !Number.isInteger(delay) ||
      delay < 1 ||
      delay > CAMPAIGN_LIMITS.delayDaysMax
    ) {
      throw new CrmError(
        'invalid_input',
        `steps[${i}].delayDays must be a whole number of days between 1 and ${CAMPAIGN_LIMITS.delayDaysMax}.`
      );
    }
    const message = validateMessageTemplate(step, `steps[${i}]`);
    return { delayDays: delay, ...message };
  });
}

/** The contact fields a template may personalize from, as strings. */
export interface TemplateContact {
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  role: string | null;
  email: string | null;
  headline: string | null;
  location: string | null;
  industry: string | null;
}

/**
 * Build the variable map for one recipient. First/last names fall back to
 * splitting the full name (imports often carry only `fullName`), so
 * "Hi {{firstName}}" works for every contact. Nulls render as empty strings.
 */
export function contactToTemplateVars(
  contact: TemplateContact,
  overrides: Record<string, unknown> | null = null
): Record<string, string> {
  const parts = contact.fullName.trim().split(/\s+/);
  const vars: Record<string, string> = {
    fullName: contact.fullName,
    firstName: contact.firstName ?? (parts.length > 1 ? parts[0]! : contact.fullName),
    lastName: contact.lastName ?? (parts.length > 1 ? parts.slice(1).join(' ') : ''),
    company: contact.company ?? '',
    role: contact.role ?? '',
    email: contact.email ?? '',
    headline: contact.headline ?? '',
    location: contact.location ?? '',
    industry: contact.industry ?? '',
  };
  if (overrides) {
    for (const key of TEMPLATE_VARIABLES) {
      const value = overrides[key];
      if (typeof value === 'string') vars[key] = value;
    }
  }
  return vars;
}

/** Replace every whitelisted `{{var}}`; unknown ones were rejected at save time. */
export function renderTemplateText(text: string, vars: Record<string, string>): string {
  return text.replace(VARIABLE_RE, (_match, name: string) => vars[name] ?? '');
}

export function renderMessage(
  template: MessageTemplate,
  vars: Record<string, string>
): MessageTemplate {
  return {
    subject: renderTemplateText(template.subject, vars),
    body: renderTemplateText(template.body, vars),
  };
}
