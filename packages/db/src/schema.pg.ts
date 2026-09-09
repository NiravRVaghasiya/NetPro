import { sql } from 'drizzle-orm';
import { pgTable, uniqueIndex, text, integer, real, boolean, timestamp, primaryKey, index, unique } from 'drizzle-orm/pg-core';
import type { AdapterAccountType } from 'next-auth/adapters';

// v3.0 Phase 1 — workspaces data model (migration 0008). Single-owner installs
// get a bootstrap workspace `default`; multi-member installs share it until
// multi-workspace UI lands in v3.x. Every data table gains `workspace_id`
// (nullable in SQL, backfilled to `default`, thereafter always written).
export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  slugUnique: unique('workspaces_slug_unique').on(t.slug),
}));

export const workspaceMembers = pgTable('workspace_members', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  workspaceUserUnique: unique('workspace_members_workspace_user_unique').on(t.workspaceId, t.userId),
  workspaceIdx: index('idx_workspace_members_workspace').on(t.workspaceId),
  userIdx: index('idx_workspace_members_user').on(t.userId),
}));

export const workspaceInvites = pgTable('workspace_invites', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  role: text('role').notNull().default('member'),
  expiresAt: text('expires_at').notNull(),
  createdBy: text('created_by'),
  acceptedAt: text('accepted_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  tokenUnique: unique('workspace_invites_token_unique').on(t.token),
  workspaceIdx: index('idx_workspace_invites_workspace').on(t.workspaceId),
  expiresIdx: index('idx_workspace_invites_expires').on(t.expiresAt),
}));

export const contacts = pgTable('contacts', {
  id: text('id').primaryKey(),

  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),

  fullName: text('full_name').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email'),
  emailVerified: boolean('email_verified').default(false),
  phone: text('phone'),
  avatarUrl: text('avatar_url'),

  headline: text('headline'),
  company: text('company'),
  companyDomain: text('company_domain'),
  role: text('role'),
  seniority: text('seniority'),
  department: text('department'),
  industry: text('industry'),

  location: text('location'),
  country: text('country'),
  timezone: text('timezone'),

  linkedinUrl: text('linkedin_url'),
  githubUrl: text('github_url'),
  twitterUrl: text('twitter_url'),
  websiteUrl: text('website_url'),

  source: text('source').notNull(),
  sourceId: text('source_id'),
  tags: text('tags'),
  customFields: text('custom_fields'),
  notes: text('notes'),
  /** Derived, explainable skills from Phase 5; JSON array of taxonomy names. */
  skills: text('skills'),

  relationshipScore: real('relationship_score').default(0),
  lastInteraction: text('last_interaction'),
  interactionCount: integer('interaction_count').default(0),

  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  deletedAt: text('deleted_at'),
}, (t) => ({
  // CRM read paths: score-ordered lists (search `score` sort, dormant ties)
  // and last-touch recency scans. Index plan from the DB & Pipeline Deep Dive.
  relationshipScoreIdx: index('idx_contacts_relationship_score').on(t.relationshipScore),
  lastInteractionIdx: index('idx_contacts_last_interaction').on(t.lastInteraction),
  workspaceIdx: index('idx_contacts_workspace').on(t.workspaceId),
  workspaceUpdatedIdx: index('idx_contacts_workspace_updated').on(t.workspaceId, t.updatedAt),
}));

export const interactions = pgTable('interactions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),
  // v3.0 Phase 2 — authorship: who logged this interaction.
  createdByUser: text('created_by_user'),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),

  type: text('type').notNull(),
  direction: text('direction'),
  subject: text('subject'),
  content: text('content'),
  sentiment: text('sentiment'),

  channel: text('channel'),
  campaignId: text('campaign_id').references(() => campaigns.id),

  occurredAt: text('occurred_at').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  // Per-contact history (timeline, score recompute) and campaign stats.
  contactIdx: index('idx_interactions_contact').on(t.contactId, t.occurredAt),
  campaignIdx: index('idx_interactions_campaign').on(t.campaignId),
  workspaceIdx: index('idx_interactions_workspace').on(t.workspaceId),
  workspaceContactIdx: index('idx_interactions_workspace_contact').on(t.workspaceId, t.contactId),
  authorIdx: index('idx_interactions_author').on(t.createdByUser),
}));

export const edges = pgTable('edges', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  targetId: text('target_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),

  relation: text('relation').notNull(),
  strength: real('strength').default(0.5),
  context: text('context'),
  bidirectional: boolean('bidirectional').default(true),

  source: text('source').notNull().default('manual'),
  confidence: real('confidence').default(1),
  status: text('status').notNull().default('confirmed'),

  discoveredAt: text('discovered_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  sourceIdx: index('idx_edges_source').on(t.sourceId),
  targetIdx: index('idx_edges_target').on(t.targetId),
  relationIdx: index('idx_edges_relation').on(t.relation),
  confidenceIdx: index('idx_edges_confidence').on(t.confidence),
  statusIdx: index('idx_edges_status').on(t.status),
  workspaceIdx: index('idx_edges_workspace').on(t.workspaceId),
}));

export const events = pgTable('events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  location: text('location'),
  startsAt: text('starts_at'),
  endsAt: text('ends_at'),
  source: text('source').notNull().default('manual'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  workspaceIdx: index('idx_events_workspace').on(t.workspaceId),
}));

export const eventAttendees = pgTable('event_attendees', {
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),
  role: text('role'),
  attended: boolean('attended').default(true),
  discoveredAt: text('discovered_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  pk: primaryKey({ columns: [t.eventId, t.contactId] }),
  contactIdx: index('idx_event_attendees_contact').on(t.contactId),
  workspaceIdx: index('idx_event_attendees_workspace').on(t.workspaceId),
}));

// v2.5 Phase 4 — content cross-posting tracker (migration `0007`).
// `url` is the link as given; `url_norm` is the canonical dedupe key
// (lower-cased host, no fragment, tracking params stripped, sorted query —
// see `packages/core/src/content/urls.ts`), UNIQUE so a re-import can never
// double-count the same post.
export const contentItems = pgTable('content_items', {
  id: text('id').primaryKey(),

  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),

  url: text('url').notNull(),
  urlNorm: text('url_norm').notNull(),
  title: text('title').notNull(),
  platform: text('platform').notNull(),
  type: text('type'),
  publishedAt: text('published_at'),
  author: text('author'),
  // Plain text on Postgres (stringified in code), JSON-mode on SQLite — the
  // same portability trade-off as contacts.tags and activity_log.metadata.
  tags: text('tags'),
  summary: text('summary'),

  source: text('source').notNull().default('manual'),

  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  urlNormUnique: unique('content_items_url_norm_unique').on(t.urlNorm),
  platformIdx: index('idx_content_items_platform').on(t.platform),
  publishedIdx: index('idx_content_items_published').on(t.publishedAt),
  workspaceIdx: index('idx_content_items_workspace').on(t.workspaceId),
}));

// Time-series engagement snapshots, one row per fetch. Metrics are nullable
// because a provider may report only some of them (RSS reports none — a
// manual entry reports whatever the owner typed).
export const contentMetrics = pgTable('content_metrics', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),
  contentId: text('content_id').notNull().references(() => contentItems.id, { onDelete: 'cascade' }),

  fetchedAt: text('fetched_at').notNull(),
  source: text('source').notNull().default('manual'),

  views: integer('views'),
  likes: integer('likes'),
  comments: integer('comments'),
  shares: integer('shares'),
  bookmarks: integer('bookmarks'),

  rawPayload: text('raw_payload'),

  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  itemTimeIdx: index('idx_content_metrics_item_time').on(t.contentId, t.fetchedAt),
  timeIdx: index('idx_content_metrics_time').on(t.fetchedAt),
  workspaceIdx: index('idx_content_metrics_workspace').on(t.workspaceId),
}));

// Which of your contacts a piece of content involves (\"co-authored with Ada\",
// \"mentions Bob\"). Composite PK: one row per (content, contact) pair.
export const contentMentions = pgTable('content_mentions', {
  contentId: text('content_id').notNull().references(() => contentItems.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),
  context: text('context'),
}, (t) => ({
  pk: primaryKey({ columns: [t.contentId, t.contactId] }),
  contactIdx: index('idx_content_mentions_contact').on(t.contactId),
  contentIdx: index('idx_content_mentions_content').on(t.contentId),
  workspaceIdx: index('idx_content_mentions_workspace').on(t.workspaceId),
}));

export const enrichments = pgTable('enrichments', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),

  provider: text('provider').notNull(),
  dataType: text('data_type').notNull(),
  rawPayload: text('raw_payload'),
  confidence: real('confidence'),

  fetchedAt: text('fetched_at').notNull().$defaultFn(() => new Date().toISOString()),
  expiresAt: text('expires_at'),
  stale: boolean('stale').default(false),
}, (t) => ({
  workspaceIdx: index('idx_enrichments_workspace').on(t.workspaceId),
}));

export const campaigns = pgTable('campaigns', {
  id: text('id').primaryKey(),

  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  description: text('description'),
  status: text('status').default('draft'),
  type: text('type').default('single'),

  template: text('template'),
  steps: text('steps'),

  sendFrom: text('send_from'),
  sendVia: text('send_via'),
  dailyLimit: integer('daily_limit').default(50),

  totalRecipients: integer('total_recipients').default(0),
  sent: integer('sent').default(0),
  opened: integer('opened').default(0),
  replied: integer('replied').default(0),
  bounced: integer('bounced').default(0),

  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  statusIdx: index('idx_campaigns_status').on(t.status),
  workspaceIdx: index('idx_campaigns_workspace').on(t.workspaceId),
}));

export const campaignRecipients = pgTable('campaign_recipients', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),
  campaignId: text('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),

  status: text('status').default('pending'),
  currentStep: integer('current_step').default(0),
  personalizedVars: text('personalized_vars'),

  scheduledAt: text('scheduled_at'),
  sentAt: text('sent_at'),
  openedAt: text('opened_at'),
  repliedAt: text('replied_at'),
  bouncedAt: text('bounced_at'),

  errorMessage: text('error_message'),
}, (t) => ({
  // Campaign detail views (per-status) and the drip schedule.
  statusIdx: index('idx_campaign_recipients_status').on(t.campaignId, t.status),
  scheduledIdx: index('idx_campaign_recipients_scheduled').on(t.scheduledAt),
  workspaceIdx: index('idx_campaign_recipients_workspace').on(t.workspaceId),
}));

export const searchIndex = pgTable('search_index', {
  contactId: text('contact_id').primaryKey().references(() => contacts.id, { onDelete: 'cascade' }),

  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),

  searchText: text('search_text').notNull(),

  companyNorm: text('company_norm'),
  roleNorm: text('role_norm'),
  locationNorm: text('location_norm'),
  seniorityNorm: text('seniority_norm'),
  industryNorm: text('industry_norm'),

  // Semantic arm (v2.0 Phase 4). The vector is stored portably as a JSON
  // array of floats so the same producer works on SQLite and Postgres; a
  // native pgvector column + ANN index is a documented later optimization
  // (see docs/superpowers/plans/2026-09-07-v2.0-phase4-hybrid-search-progress.md).
  embedding: text('embedding'),
  embeddingModel: text('embedding_model'),
  embeddingDim: integer('embedding_dim'),
  embeddingUpdatedAt: text('embedding_updated_at'),

  /** Hash of searchText — lets a reindex skip unchanged rows (and not re-pay for embeddings). */
  contentHash: text('content_hash'),

  updatedAt: text('updated_at').notNull(),
}, (t) => ({
  updatedAtIdx: index('idx_search_index_updated_at').on(t.updatedAt),
  workspaceIdx: index('idx_search_index_workspace').on(t.workspaceId),
}));

export const profileViews = pgTable('profile_views', {
  id: text('id').primaryKey(),

  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),

  // v2.5 Phase 1 privacy hardening (migration `0006`). `viewer_ip` no longer
  // holds a raw IP: the producer stores HMAC-SHA256(ip + UA) under a salt
  // that rotates every UTC day (see `packages/core/src/views/privacy.ts`),
  // truncated to 16 hex chars. Migration `0006` also nulls any legacy raw
  // value, so no raw IP can survive an upgrade.
  viewerIp: text('viewer_ip'),
  viewerAgent: text('viewer_agent'),
  referrer: text('referrer'),
  resolvedContact: text('resolved_contact').references(() => contacts.id),

  // 24h dedup fingerprint (hash of IP + UA + accept-language under the same
  // daily salt) — not a cross-session tracker, unusable across days.
  viewerFingerprint: text('viewer_fingerprint'),
  // Filtered out of analytics; owner views are excluded from counts.
  isBot: boolean('is_bot').notNull().default(false),
  isOwnerView: boolean('is_owner_view').notNull().default(false),
  // Ephemeral per-view session tag, for de-duping rapid reloads only.
  sessionId: text('session_id'),
  // Optional, from the page-lifecycle beacon (Phase 2).
  durationMs: integer('duration_ms'),

  // Campaign attribution, parsed from the referral query string.
  utmSource: text('utm_source'),
  utmMedium: text('utm_medium'),
  utmCampaign: text('utm_campaign'),
  // Future-proofing: multiple public cards would each get their own id.
  viewedCardId: text('viewed_card_id'),

  viewedPage: text('viewed_page').notNull(),
  viewedAt: text('viewed_at').notNull().$defaultFn(() => new Date().toISOString()),

  country: text('country'),
  city: text('city'),
}, (t) => ({
  // v2.5 Phase 1 indexes (migration `0006`): timeline queries, resolved-view
  // lookups, page filters, the 24h dedup probe, and the analytics fast path
  // over non-bot views.
  timeIdx: index('idx_profile_views_time').on(t.viewedAt),
  resolvedIdx: index('idx_profile_views_resolved')
    .on(t.resolvedContact)
    .where(sql`${t.resolvedContact} IS NOT NULL`),
  pageIdx: index('idx_profile_views_page').on(t.viewedPage),
  fingerprintTimeIdx: index('idx_profile_views_fingerprint_time').on(
    t.viewerFingerprint,
    t.viewedAt,
  ),
  nonBotTimeIdx: index('idx_profile_views_is_bot')
    .on(t.viewedAt)
    .where(sql`${t.isBot} = false`),
  workspaceIdx: index('idx_profile_views_workspace').on(t.workspaceId),
  workspaceTimeIdx: index('idx_profile_views_workspace_time').on(t.workspaceId, t.viewedAt),
}));

export const followUps = pgTable('follow_ups', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),
  // v3.0 Phase 2 — authorship: who created this follow-up.
  createdByUser: text('created_by_user'),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),

  reason: text('reason'),
  dueAt: text('due_at').notNull(),
  snoozedUntil: text('snoozed_until'),

  status: text('status').default('pending'),
  completedAt: text('completed_at'),

  recurring: boolean('recurring').default(false),
  recurrenceRule: text('recurrence_rule'),

  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  // Due lists and per-contact pending lookups.
  dueIdx: index('idx_followups_due').on(t.dueAt),
  contactIdx: index('idx_followups_contact').on(t.contactId),
  workspaceIdx: index('idx_followups_workspace').on(t.workspaceId),
  workspaceStatusDueIdx: index('idx_followups_workspace_status_due').on(t.workspaceId, t.status, t.dueAt),
  authorIdx: index('idx_followups_author').on(t.createdByUser),
}));

export const activityLog = pgTable('activity_log', {
  id: text('id').primaryKey(),

  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),

  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  metadata: text('metadata'),

  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  workspaceIdx: index('idx_activity_log_workspace').on(t.workspaceId),
  workspaceTimeIdx: index('idx_activity_log_workspace_time').on(t.workspaceId, t.createdAt),
}));

export const users = pgTable('user', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').notNull(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
});

export const accounts = pgTable(
  'account',
  {
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<AdapterAccountType>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (account) => ({
    compoundKey: primaryKey({ columns: [account.provider, account.providerAccountId] }),
  })
);

export const sessions = pgTable('session', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable(
  'verificationToken',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (vt) => ({
    compoundKey: primaryKey({ columns: [vt.identifier, vt.token] }),
  })
);

// Single-owner public card. Plain JSON text in both dialects; draft and published
// snapshots are separate so private edits never change the live card implicitly.
export const profileCards = pgTable('profile_cards', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').default('default').references(() => workspaces.id, { onDelete: 'cascade' }),
  draft: text('draft').notNull(),
  published: text('published'),
  publishedAt: text('published_at'),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  workspaceIdx: index('idx_profile_cards_workspace').on(t.workspaceId),
}));

// Separate partial indexes make the nullable workspace principal truly unique.
export const keyVault = pgTable('key_vault', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  keyName: text('key_name').notNull(),
  ciphertext: text('ciphertext').notNull(),
  lastFour: text('last_four').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastUsedAt: text('last_used_at'),
}, (t) => [
  uniqueIndex('key_vault_personal_unique').on(t.workspaceId, t.userId, t.keyName).where(sql`${t.userId} IS NOT NULL`),
  uniqueIndex('key_vault_workspace_unique').on(t.workspaceId, t.keyName).where(sql`${t.userId} IS NULL`),
]);
