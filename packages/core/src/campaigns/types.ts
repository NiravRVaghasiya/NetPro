// packages/core/src/campaigns/types.ts
//
// Campaign vocabulary and limits. Statuses and the recipient lifecycle come
// from the "DB & Pipeline Deep Dive" campaigns schema; the transition matrix
// is the draft-only campaign's guardrail (Phase 8 design spec).

import type { SearchContactsOptions } from '../search/types';

export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed', 'archived'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Allowed lifecycle transitions; anything else is a conflict error. */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'completed', 'archived'],
  paused: ['active', 'completed', 'archived'],
  completed: ['archived'],
  archived: [],
};

/**
 * Recipient lifecycle. The schema comment lists delivery-funnel states
 * (delivered/opened/clicked/bounced/unsubscribed) that only a real transport
 * can observe; draft-only campaigns use the human-confirmed subset:
 *
 *   pending   — nothing sent yet (step 0 ready)
 *   scheduled — a step was sent; the next one is queued (advice, not a worker)
 *   sent      — the whole sequence was sent
 *   replied   — they answered; the drip stops (blueprint `condition: no_reply`)
 *   skipped   — manually opted out; nothing sent, nothing logged
 */
export const RECIPIENT_STATUSES = ['pending', 'scheduled', 'sent', 'replied', 'skipped'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

/** Whitelisted merge variables — pure string replacement, no template engine. */
export const TEMPLATE_VARIABLES = [
  'firstName',
  'lastName',
  'fullName',
  'company',
  'role',
  'email',
  'headline',
  'location',
  'industry',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export interface MessageTemplate {
  subject: string;
  body: string;
}

export interface DripStep {
  /** Whole days to wait after the previous message before this one is due. */
  delayDays: number;
  subject: string;
  body: string;
}

export const CAMPAIGN_LIMITS = {
  name: 120,
  description: 1000,
  subject: 200,
  body: 5000,
  sendFrom: 320,
  /** Max drip follow-ups after the initial message. */
  steps: 5,
  /** Max recipients per campaign. */
  recipients: 1000,
  dailyLimitMax: 1000,
  delayDaysMax: 365,
} as const;

export type CampaignType = 'single' | 'sequence';

export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  type: CampaignType;
  template: MessageTemplate;
  steps: DripStep[];
  sendFrom: string | null;
  /** Always null in draft-only mode — a delivery phase owns this column. */
  sendVia: string | null;
  dailyLimit: number;
  totalRecipients: number;
  sent: number;
  opened: number;
  replied: number;
  bounced: number;
  createdAt: string;
  updatedAt: string;
}

/** How a campaign gets its audience: explicit ids or a search snapshot. */
export interface RecipientSelection {
  contactIds?: string[];
  search?: SearchContactsOptions;
}

export interface CampaignsOptions {
  now?: Date;
}

/** The full sendable sequence: initial template followed by the drip steps. */
export function campaignSequence(campaign: Pick<Campaign, 'template' | 'steps'>): MessageTemplate[] {
  return [campaign.template, ...campaign.steps.map((s) => ({ subject: s.subject, body: s.body }))];
}
