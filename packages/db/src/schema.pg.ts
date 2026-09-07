import { pgTable, text, integer, real, boolean, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import type { AdapterAccountType } from 'next-auth/adapters';

export const contacts = pgTable('contacts', {
  id: text('id').primaryKey(),

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
}));

export const interactions = pgTable('interactions', {
  id: text('id').primaryKey(),
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
}));

export const edges = pgTable('edges', {
  id: text('id').primaryKey(),
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
}));

export const events = pgTable('events', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  location: text('location'),
  startsAt: text('starts_at'),
  endsAt: text('ends_at'),
  source: text('source').notNull().default('manual'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const eventAttendees = pgTable('event_attendees', {
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  role: text('role'),
  attended: boolean('attended').default(true),
  discoveredAt: text('discovered_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  pk: primaryKey({ columns: [t.eventId, t.contactId] }),
  contactIdx: index('idx_event_attendees_contact').on(t.contactId),
}));

export const enrichments = pgTable('enrichments', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),

  provider: text('provider').notNull(),
  dataType: text('data_type').notNull(),
  rawPayload: text('raw_payload'),
  confidence: real('confidence'),

  fetchedAt: text('fetched_at').notNull().$defaultFn(() => new Date().toISOString()),
  expiresAt: text('expires_at'),
  stale: boolean('stale').default(false),
});

export const campaigns = pgTable('campaigns', {
  id: text('id').primaryKey(),

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
}));

export const campaignRecipients = pgTable('campaign_recipients', {
  id: text('id').primaryKey(),
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
}));

export const searchIndex = pgTable('search_index', {
  contactId: text('contact_id').primaryKey().references(() => contacts.id, { onDelete: 'cascade' }),

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
}));

export const profileViews = pgTable('profile_views', {
  id: text('id').primaryKey(),

  viewerIp: text('viewer_ip'),
  viewerAgent: text('viewer_agent'),
  referrer: text('referrer'),
  resolvedContact: text('resolved_contact').references(() => contacts.id),

  viewedPage: text('viewed_page').notNull(),
  viewedAt: text('viewed_at').notNull().$defaultFn(() => new Date().toISOString()),

  country: text('country'),
  city: text('city'),
});

export const followUps = pgTable('follow_ups', {
  id: text('id').primaryKey(),
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
}));

export const activityLog = pgTable('activity_log', {
  id: text('id').primaryKey(),

  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  metadata: text('metadata'),

  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

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
  draft: text('draft').notNull(),
  published: text('published'),
  publishedAt: text('published_at'),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});
