import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
import type { AdapterAccountType } from 'next-auth/adapters';

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),

  fullName: text('full_name').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email'),
  emailVerified: integer('email_verified', { mode: 'boolean' }).default(false),
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
  tags: text('tags', { mode: 'json' }),
  customFields: text('custom_fields', { mode: 'json' }),
  notes: text('notes'),

  relationshipScore: real('relationship_score').default(0),
  lastInteraction: text('last_interaction'),
  interactionCount: integer('interaction_count').default(0),

  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  deletedAt: text('deleted_at'),
});

export const interactions = sqliteTable('interactions', {
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
});

export const edges = sqliteTable('edges', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  targetId: text('target_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),

  relation: text('relation').notNull(),
  strength: real('strength').default(0.5),
  context: text('context'),
  bidirectional: integer('bidirectional', { mode: 'boolean' }).default(true),

  discoveredAt: text('discovered_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const enrichments = sqliteTable('enrichments', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),

  provider: text('provider').notNull(),
  dataType: text('data_type').notNull(),
  rawPayload: text('raw_payload', { mode: 'json' }),
  confidence: real('confidence'),

  fetchedAt: text('fetched_at').notNull().$defaultFn(() => new Date().toISOString()),
  expiresAt: text('expires_at'),
  stale: integer('stale', { mode: 'boolean' }).default(false),
});

export const campaigns = sqliteTable('campaigns', {
  id: text('id').primaryKey(),

  name: text('name').notNull(),
  description: text('description'),
  status: text('status').default('draft'),
  type: text('type').default('single'),

  template: text('template', { mode: 'json' }),
  steps: text('steps', { mode: 'json' }),

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
});

export const campaignRecipients = sqliteTable('campaign_recipients', {
  id: text('id').primaryKey(),
  campaignId: text('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),

  status: text('status').default('pending'),
  currentStep: integer('current_step').default(0),
  personalizedVars: text('personalized_vars', { mode: 'json' }),

  scheduledAt: text('scheduled_at'),
  sentAt: text('sent_at'),
  openedAt: text('opened_at'),
  repliedAt: text('replied_at'),
  bouncedAt: text('bounced_at'),

  errorMessage: text('error_message'),
});

export const searchIndex = sqliteTable('search_index', {
  contactId: text('contact_id').primaryKey().references(() => contacts.id, { onDelete: 'cascade' }),

  searchText: text('search_text').notNull(),

  companyNorm: text('company_norm'),
  roleNorm: text('role_norm'),
  locationNorm: text('location_norm'),
  seniorityNorm: text('seniority_norm'),
  industryNorm: text('industry_norm'),

  embedding: text('embedding'),
  embeddingModel: text('embedding_model'),

  updatedAt: text('updated_at').notNull(),
});

export const profileViews = sqliteTable('profile_views', {
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

export const followUps = sqliteTable('follow_ups', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),

  reason: text('reason'),
  dueAt: text('due_at').notNull(),
  snoozedUntil: text('snoozed_until'),

  status: text('status').default('pending'),
  completedAt: text('completed_at'),

  recurring: integer('recurring', { mode: 'boolean' }).default(false),
  recurrenceRule: text('recurrence_rule'),

  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const activityLog = sqliteTable('activity_log', {
  id: text('id').primaryKey(),

  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  metadata: text('metadata', { mode: 'json' }),

  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const users = sqliteTable('user', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').notNull(),
  emailVerified: integer('emailVerified', { mode: 'timestamp_ms' }),
  image: text('image'),
});

export const accounts = sqliteTable(
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

export const sessions = sqliteTable('session', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: integer('expires', { mode: 'timestamp_ms' }).notNull(),
});

export const verificationTokens = sqliteTable(
  'verificationToken',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: integer('expires', { mode: 'timestamp_ms' }).notNull(),
  },
  (vt) => ({
    compoundKey: primaryKey({ columns: [vt.identifier, vt.token] }),
  })
);
