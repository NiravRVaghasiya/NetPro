# NetPro — Database Design & Data Pipeline Architecture

> Deep-dive into the storage layer, schema design, migration strategy, query patterns, and the enrichment/search data pipeline.

---

## Part 1: Database Design

---

### 1.1 Dual-Mode Storage Strategy

NetPro runs in two modes with the **same schema** (powered by Drizzle ORM's dialect abstraction):

| Mode | Engine | Use Case | Trade-offs |
|------|--------|----------|------------|
| **Local (CLI)** | SQLite + SQLCipher | Single-user, offline-first, zero-config | No concurrency, max ~10GB practical |
| **Cloud (Web)** | Supabase Postgres | Multi-user, hosted, real-time sync | Requires network, Supabase free tier limits |

**Why this works:** Drizzle ORM compiles the same TypeScript schema into dialect-specific SQL. You write once, deploy anywhere.

```
┌─────────────────────────────────────────┐
│           @netpro/db package            │
│                                         │
│  schema.ts  ──→  SQLite dialect (CLI)   │
│             ──→  Postgres dialect (Web)  │
│                                         │
│  migrations/  (generated per dialect)   │
└─────────────────────────────────────────┘
```

---

### 1.2 Complete Schema Definition

```typescript
// packages/db/src/schema.ts
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
// Note: For Postgres, swap imports to 'drizzle-orm/pg-core'
// The Drizzle Kit config handles dialect switching

// ═══════════════════════════════════════════════
// CONTACTS — Core entity, center of the universe
// ═══════════════════════════════════════════════

export const contacts = sqliteTable('contacts', {
  id:           text('id').primaryKey(),          // nanoid
  
  // Identity
  fullName:     text('full_name').notNull(),
  firstName:    text('first_name'),
  lastName:     text('last_name'),
  email:        text('email'),
  emailVerified: integer('email_verified', { mode: 'boolean' }).default(false),
  phone:        text('phone'),
  avatarUrl:    text('avatar_url'),
  
  // Professional
  headline:     text('headline'),                 // "Sr. Engineer at Stripe"
  company:      text('company'),
  companyDomain: text('company_domain'),          // "stripe.com"
  role:         text('role'),                     // Normalized title
  seniority:    text('seniority'),               // junior | mid | senior | lead | exec
  department:   text('department'),
  industry:     text('industry'),
  
  // Location
  location:     text('location'),                 // Free text: "San Francisco, CA"
  country:      text('country'),                  // ISO 3166-1 alpha-2
  timezone:     text('timezone'),                 // IANA: "America/Los_Angeles"
  
  // External profiles
  linkedinUrl:  text('linkedin_url'),
  githubUrl:    text('github_url'),
  twitterUrl:   text('twitter_url'),
  websiteUrl:   text('website_url'),
  
  // Metadata
  source:       text('source').notNull(),         // 'linkedin_csv' | 'github' | 'manual' | 'hunter' | 'pdl'
  sourceId:     text('source_id'),               // External ID from source system
  tags:         text('tags', { mode: 'json' }),  // ["eng", "speaker", "met-irl"]
  customFields: text('custom_fields', { mode: 'json' }), // User-defined k/v
  notes:        text('notes'),
  
  // Relationship scoring
  relationshipScore: real('relationship_score').default(0), // 0-100 computed
  lastInteraction:   text('last_interaction'),              // ISO timestamp
  interactionCount:  integer('interaction_count').default(0),
  
  // System
  createdAt:    text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt:    text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  deletedAt:    text('deleted_at'),              // Soft delete
});

// ═══════════════════════════════════════════════
// INTERACTIONS — Every touchpoint with a contact
// ═══════════════════════════════════════════════

export const interactions = sqliteTable('interactions', {
  id:          text('id').primaryKey(),
  contactId:   text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  
  type:        text('type').notNull(),
  // Types: 'email_sent' | 'email_received' | 'meeting' | 'call' |
  //        'note' | 'linkedin_message' | 'intro_made' | 'follow_up_due'
  
  direction:   text('direction'),                // 'inbound' | 'outbound'
  subject:     text('subject'),
  content:     text('content'),                  // Body or notes
  sentiment:   text('sentiment'),                // 'positive' | 'neutral' | 'negative' (AI-scored)
  
  // Context
  channel:     text('channel'),                  // 'email' | 'linkedin' | 'twitter' | 'in_person'
  campaignId:  text('campaign_id').references(() => campaigns.id),
  
  // Timestamps
  occurredAt:  text('occurred_at').notNull(),    // When it actually happened
  createdAt:   text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ═══════════════════════════════════════════════
// NETWORK GRAPH — Relationships between contacts
// ═══════════════════════════════════════════════

export const edges = sqliteTable('edges', {
  id:          text('id').primaryKey(),
  sourceId:    text('source_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  targetId:    text('target_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  
  relation:    text('relation').notNull(),
  // Types: 'connection' | 'colleague' | 'reports_to' | 'met_at' |
  //        'introduced_by' | 'collaborator' | 'mutual_contact'
  
  strength:    real('strength').default(0.5),    // 0.0 - 1.0, decays over time
  context:     text('context'),                  // "Both at Stripe 2022-2024"
  bidirectional: integer('bidirectional', { mode: 'boolean' }).default(true),
  
  discoveredAt: text('discovered_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt:    text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ═══════════════════════════════════════════════
// ENRICHMENTS — Raw data from external providers
// ═══════════════════════════════════════════════

export const enrichments = sqliteTable('enrichments', {
  id:          text('id').primaryKey(),
  contactId:   text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  
  provider:    text('provider').notNull(),       // 'hunter' | 'pdl' | 'github' | 'clearbit'
  dataType:    text('data_type').notNull(),      // 'email' | 'profile' | 'company' | 'social'
  rawPayload:  text('raw_payload', { mode: 'json' }), // Full API response
  confidence:  real('confidence'),               // Provider's confidence score
  
  // Cache control
  fetchedAt:   text('fetched_at').notNull().$defaultFn(() => new Date().toISOString()),
  expiresAt:   text('expires_at'),              // TTL for re-enrichment
  stale:       integer('stale', { mode: 'boolean' }).default(false),
});

// ═══════════════════════════════════════════════
// CAMPAIGNS — Outreach sequences
// ═══════════════════════════════════════════════

export const campaigns = sqliteTable('campaigns', {
  id:          text('id').primaryKey(),
  
  name:        text('name').notNull(),
  description: text('description'),
  status:      text('status').default('draft'), // 'draft' | 'active' | 'paused' | 'completed' | 'archived'
  type:        text('type').default('single'),  // 'single' | 'sequence' | 'drip'
  
  // Template
  template:    text('template', { mode: 'json' }),
  // { subject: "...", body: "...", variables: ["name", "company", "context"] }
  
  // Sequence config (for multi-step campaigns)
  steps:       text('steps', { mode: 'json' }),
  // [{ delay: "3d", subject: "...", body: "...", condition: "no_reply" }]
  
  // Sending config
  sendFrom:    text('send_from'),               // Email address or alias
  sendVia:     text('send_via'),                // 'smtp' | 'resend' | 'gmail'
  dailyLimit:  integer('daily_limit').default(50),
  
  // Stats (denormalized for quick reads)
  totalRecipients: integer('total_recipients').default(0),
  sent:        integer('sent').default(0),
  opened:      integer('opened').default(0),
  replied:     integer('replied').default(0),
  bounced:     integer('bounced').default(0),
  
  createdAt:   text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt:   text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const campaignRecipients = sqliteTable('campaign_recipients', {
  id:          text('id').primaryKey(),
  campaignId:  text('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  contactId:   text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  
  status:      text('status').default('pending'),
  // 'pending' | 'scheduled' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'replied' | 'bounced' | 'unsubscribed'
  
  currentStep: integer('current_step').default(0),
  personalizedVars: text('personalized_vars', { mode: 'json' }),
  
  scheduledAt: text('scheduled_at'),
  sentAt:      text('sent_at'),
  openedAt:    text('opened_at'),
  repliedAt:   text('replied_at'),
  bouncedAt:   text('bounced_at'),
  
  errorMessage: text('error_message'),
});

// ═══════════════════════════════════════════════
// SEARCH INDEX — Denormalized for fast queries
// ═══════════════════════════════════════════════

export const searchIndex = sqliteTable('search_index', {
  contactId:   text('contact_id').primaryKey().references(() => contacts.id, { onDelete: 'cascade' }),
  
  // Concatenated searchable text
  searchText:  text('search_text').notNull(),
  // FORMAT: "fullname | headline | company | role | location | tags | notes"
  
  // Faceted fields (for filter queries)
  companyNorm: text('company_norm'),            // Lowercase, trimmed
  roleNorm:    text('role_norm'),
  locationNorm: text('location_norm'),
  seniorityNorm: text('seniority_norm'),
  industryNorm: text('industry_norm'),
  
  // Vector embedding (for semantic search - stored as blob)
  embedding:   text('embedding'),               // JSON array of floats (384-dim)
  embeddingModel: text('embedding_model'),      // 'all-MiniLM-L6-v2'
  
  updatedAt:   text('updated_at').notNull(),
});

// ═══════════════════════════════════════════════
// PROFILE VIEWS — "Who viewed your profile" equivalent
// ═══════════════════════════════════════════════

export const profileViews = sqliteTable('profile_views', {
  id:          text('id').primaryKey(),
  
  // Viewer info (may be anonymous)
  viewerIp:    text('viewer_ip'),               // Hashed for privacy
  viewerAgent: text('viewer_agent'),            // User-agent string
  referrer:    text('referrer'),                // Where they came from
  resolvedContact: text('resolved_contact').references(() => contacts.id), // If matched to known contact
  
  // What was viewed
  viewedPage:  text('viewed_page').notNull(),   // URL path
  viewedAt:    text('viewed_at').notNull().$defaultFn(() => new Date().toISOString()),
  
  // Geo (from IP, optional)
  country:     text('country'),
  city:        text('city'),
});

// ═══════════════════════════════════════════════
// FOLLOW-UPS & REMINDERS
// ═══════════════════════════════════════════════

export const followUps = sqliteTable('follow_ups', {
  id:          text('id').primaryKey(),
  contactId:   text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  
  reason:      text('reason'),                  // "Discuss collab", "Check on job switch"
  dueAt:       text('due_at').notNull(),
  snoozedUntil: text('snoozed_until'),
  
  status:      text('status').default('pending'), // 'pending' | 'completed' | 'snoozed' | 'cancelled'
  completedAt: text('completed_at'),
  
  // Recurrence
  recurring:   integer('recurring', { mode: 'boolean' }).default(false),
  recurrenceRule: text('recurrence_rule'),       // "every:30d" | "every:quarter"
  
  createdAt:   text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ═══════════════════════════════════════════════
// ACTIVITY LOG — Audit trail
// ═══════════════════════════════════════════════

export const activityLog = sqliteTable('activity_log', {
  id:          text('id').primaryKey(),
  
  action:      text('action').notNull(),
  // 'contact.created' | 'contact.enriched' | 'email.sent' | 'campaign.started' | 'search.executed'
  
  entityType:  text('entity_type'),             // 'contact' | 'campaign' | 'enrichment'
  entityId:    text('entity_id'),
  metadata:    text('metadata', { mode: 'json' }),
  
  createdAt:   text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});
```

---

### 1.3 Indexing Strategy

```sql
-- ═══ Performance-critical indexes ═══

-- Contacts: search & filter
CREATE INDEX idx_contacts_email ON contacts(email) WHERE email IS NOT NULL;
CREATE INDEX idx_contacts_company ON contacts(company);
CREATE INDEX idx_contacts_source ON contacts(source);
CREATE INDEX idx_contacts_relationship_score ON contacts(relationship_score DESC);
CREATE INDEX idx_contacts_last_interaction ON contacts(last_interaction DESC);
CREATE INDEX idx_contacts_deleted ON contacts(deleted_at) WHERE deleted_at IS NULL;

-- Full-text search (SQLite FTS5)
CREATE VIRTUAL TABLE contacts_fts USING fts5(
  full_name, headline, company, role, location, tags, notes,
  content='contacts',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Interactions: timeline queries
CREATE INDEX idx_interactions_contact ON interactions(contact_id, occurred_at DESC);
CREATE INDEX idx_interactions_type ON interactions(type, occurred_at DESC);
CREATE INDEX idx_interactions_campaign ON interactions(campaign_id) WHERE campaign_id IS NOT NULL;

-- Edges: graph traversal
CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);
CREATE INDEX idx_edges_pair ON edges(source_id, target_id);  -- Unique path lookup

-- Enrichments: cache lookup
CREATE INDEX idx_enrichments_contact_provider ON enrichments(contact_id, provider);
CREATE INDEX idx_enrichments_stale ON enrichments(stale, expires_at) WHERE stale = 0;

-- Campaigns: status filtering
CREATE INDEX idx_campaigns_status ON campaigns(status);
CREATE INDEX idx_campaign_recipients_status ON campaign_recipients(campaign_id, status);
CREATE INDEX idx_campaign_recipients_scheduled ON campaign_recipients(scheduled_at) 
  WHERE status = 'scheduled';

-- Follow-ups: due date queries
CREATE INDEX idx_followups_due ON follow_ups(due_at) WHERE status = 'pending';
CREATE INDEX idx_followups_contact ON follow_ups(contact_id);

-- Profile views: timeline
CREATE INDEX idx_profile_views_time ON profile_views(viewed_at DESC);
CREATE INDEX idx_profile_views_resolved ON profile_views(resolved_contact) 
  WHERE resolved_contact IS NOT NULL;

-- Activity log: audit queries
CREATE INDEX idx_activity_entity ON activity_log(entity_type, entity_id);
CREATE INDEX idx_activity_time ON activity_log(created_at DESC);
```

---

### 1.4 Migration Strategy

```typescript
// packages/db/drizzle.config.ts
import type { Config } from 'drizzle-kit';

const dialect = process.env.DB_DIALECT ?? 'sqlite'; // or 'postgresql'

export default {
  schema: './src/schema.ts',
  out: `./migrations/${dialect}`,
  dialect: dialect as 'sqlite' | 'postgresql',
  dbCredentials: dialect === 'sqlite'
    ? { url: process.env.DB_PATH ?? './netpro.db' }
    : { url: process.env.DATABASE_URL! },
} satisfies Config;
```

```bash
# Generate migrations (run for each dialect)
DB_DIALECT=sqlite pnpm drizzle-kit generate
DB_DIALECT=postgresql pnpm drizzle-kit generate

# Apply migrations
DB_DIALECT=sqlite pnpm drizzle-kit migrate
```

**Versioning rules:**
- Schema changes go through Drizzle's migration system (no raw ALTER TABLE)
- Breaking changes require a data migration script in `migrations/scripts/`
- CLI auto-runs pending migrations on startup (with user confirmation)
- Web uses Supabase's migration system for production deploys

---

### 1.5 Query Patterns

```typescript
// packages/core/src/queries/contacts.ts
import { db } from '@netpro/db';
import { contacts, interactions, edges, enrichments } from '@netpro/db/schema';
import { eq, desc, and, gte, like, sql, inArray } from 'drizzle-orm';

// ─── Search with facets ───
export async function searchContacts(opts: {
  query?: string;
  role?: string;
  company?: string;
  location?: string;
  seniority?: string;
  minScore?: number;
  limit?: number;
  offset?: number;
}) {
  const conditions = [];
  
  if (opts.role) conditions.push(like(contacts.role, `%${opts.role}%`));
  if (opts.company) conditions.push(like(contacts.company, `%${opts.company}%`));
  if (opts.location) conditions.push(like(contacts.location, `%${opts.location}%`));
  if (opts.seniority) conditions.push(eq(contacts.seniority, opts.seniority));
  if (opts.minScore) conditions.push(gte(contacts.relationshipScore, opts.minScore));
  conditions.push(sql`${contacts.deletedAt} IS NULL`);

  // Full-text search via FTS5
  if (opts.query) {
    const ftsResults = await db.all(sql`
      SELECT rowid, rank FROM contacts_fts 
      WHERE contacts_fts MATCH ${opts.query}
      ORDER BY rank
      LIMIT ${opts.limit ?? 50}
    `);
    const ids = ftsResults.map(r => r.rowid);
    if (ids.length) conditions.push(inArray(contacts.id, ids));
  }

  return db.select()
    .from(contacts)
    .where(and(...conditions))
    .orderBy(desc(contacts.relationshipScore))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
}

// ─── Contact with full context ───
export async function getContactFull(contactId: string) {
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId));
  if (!contact) return null;

  const [recentInteractions, contactEdges, contactEnrichments] = await Promise.all([
    db.select()
      .from(interactions)
      .where(eq(interactions.contactId, contactId))
      .orderBy(desc(interactions.occurredAt))
      .limit(20),
    
    db.select()
      .from(edges)
      .where(sql`${edges.sourceId} = ${contactId} OR ${edges.targetId} = ${contactId}`),
    
    db.select()
      .from(enrichments)
      .where(eq(enrichments.contactId, contactId))
      .orderBy(desc(enrichments.fetchedAt)),
  ]);

  return { contact, interactions: recentInteractions, edges: contactEdges, enrichments: contactEnrichments };
}

// ─── Network graph traversal (shortest path) ───
export async function findPathToContact(fromId: string, toId: string, maxDepth = 4) {
  // BFS on the edges table
  const visited = new Set<string>([fromId]);
  const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.path.length > maxDepth) break;
    
    const neighbors = await db.select({ targetId: edges.targetId, sourceId: edges.sourceId })
      .from(edges)
      .where(sql`${edges.sourceId} = ${current.id} OR ${edges.targetId} = ${current.id}`);
    
    for (const edge of neighbors) {
      const neighborId = edge.sourceId === current.id ? edge.targetId : edge.sourceId;
      
      if (neighborId === toId) {
        return [...current.path, toId]; // Found!
      }
      
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        queue.push({ id: neighborId, path: [...current.path, neighborId] });
      }
    }
  }
  
  return null; // No path found within maxDepth
}

// ─── Relationship score decay (run daily via cron) ───
export async function decayRelationshipScores() {
  // Reduce score by 2% per week of inactivity
  await db.run(sql`
    UPDATE contacts
    SET relationship_score = relationship_score * 0.98,
        updated_at = datetime('now')
    WHERE last_interaction < datetime('now', '-7 days')
      AND relationship_score > 5
      AND deleted_at IS NULL
  `);
}

// ─── Dormant connections ───
export async function getDormantConnections(daysSinceContact: number = 90) {
  return db.select()
    .from(contacts)
    .where(and(
      sql`${contacts.lastInteraction} < datetime('now', '-${daysSinceContact} days')`,
      gte(contacts.relationshipScore, 30), // Only surface important ones
      sql`${contacts.deletedAt} IS NULL`
    ))
    .orderBy(desc(contacts.relationshipScore))
    .limit(20);
}

// ─── Network cluster detection ───
export async function getNetworkClusters() {
  // Get all edges, build adjacency list, run community detection
  const allEdges = await db.select().from(edges);
  const allContacts = await db.select({
    id: contacts.id,
    name: contacts.fullName,
    company: contacts.company,
  }).from(contacts).where(sql`${contacts.deletedAt} IS NULL`);
  
  // Use graphology for community detection
  // (actual implementation uses Louvain algorithm)
  return { edges: allEdges, contacts: allContacts };
}
```

---

### 1.6 Row-Level Security (Postgres/Supabase)

```sql
-- Enable RLS on all tables
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichments ENABLE ROW LEVEL SECURITY;

-- Users can only access their own data
CREATE POLICY "Users access own contacts"
  ON contacts FOR ALL
  USING (auth.uid() = owner_id);

CREATE POLICY "Users access own interactions"
  ON interactions FOR ALL
  USING (
    contact_id IN (
      SELECT id FROM contacts WHERE owner_id = auth.uid()
    )
  );

-- Public profile card (no auth required for viewing)
CREATE POLICY "Public card viewing"
  ON contacts FOR SELECT
  USING (
    id IN (SELECT contact_id FROM public_cards WHERE is_active = true)
  );
```

---

---

## Part 2: Data Pipeline Architecture

---

### 2.1 Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        DATA PIPELINE ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐         │
│  │  INGEST   │───▶│ NORMALIZE │───▶│  ENRICH   │───▶│   INDEX   │         │
│  └───────────┘    └───────────┘    └───────────┘    └───────────┘         │
│       │                │                │                │                  │
│       ▼                ▼                ▼                ▼                  │
│  ┌─────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐          │
│  │ Sources │    │   Dedup   │    │ Providers │    │  FTS + Vec │          │
│  │• CSV    │    │   Clean   │    │ • Hunter  │    │  • FTS5    │          │
│  │• GitHub │    │   Validate│    │ • PDL     │    │  • Embed   │          │
│  │• Manual │    │   Merge   │    │ • GitHub  │    │  • Facets  │          │
│  │• API    │    │           │    │ • Clearbit│    │            │          │
│  └─────────┘    └───────────┘    └───────────┘    └───────────┘          │
│                                                                             │
│  ┌───────────┐    ┌───────────┐    ┌───────────┐                          │
│  │  ANALYZE  │───▶│  SCORE    │───▶│  SURFACE  │                          │
│  └───────────┘    └───────────┘    └───────────┘                          │
│       │                │                │                                  │
│       ▼                ▼                ▼                                  │
│  ┌─────────┐    ┌───────────┐    ┌───────────┐                          │
│  │ Graph   │    │ Relations │    │  Actions  │                           │
│  │ Metrics │    │ Scoring   │    │ • Suggest │                           │
│  │ Cluster │    │ Decay     │    │ • Remind  │                           │
│  │ Central │    │ Boost     │    │ • Alert   │                           │
│  └─────────┘    └───────────┘    └───────────┘                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 2.2 Stage 1: Ingestion Layer

```typescript
// packages/core/src/import/pipeline.ts

import { EventEmitter } from 'events';

export interface ImportSource {
  type: 'linkedin_csv' | 'github' | 'manual' | 'vcard' | 'google_contacts';
  parse(input: Buffer | string): Promise<RawContact[]>;
}

export interface RawContact {
  // Loose schema — each source maps to this
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  company?: string;
  position?: string;
  location?: string;
  linkedinUrl?: string;
  connectedOn?: string;
  raw: Record<string, unknown>; // Preserve original data
}

// ─── LinkedIn CSV Parser ───
export class LinkedInCSVParser implements ImportSource {
  type = 'linkedin_csv' as const;
  
  async parse(csv: string): Promise<RawContact[]> {
    // LinkedIn exports: First Name, Last Name, Email Address, Company, Position, Connected On
    const rows = parseCSV(csv, { header: true, skipEmptyLines: true });
    
    return rows.map(row => ({
      firstName: row['First Name']?.trim(),
      lastName: row['Last Name']?.trim(),
      fullName: `${row['First Name']?.trim()} ${row['Last Name']?.trim()}`.trim(),
      email: row['Email Address']?.trim() || undefined,
      company: row['Company']?.trim(),
      position: row['Position']?.trim(),
      linkedinUrl: row['URL']?.trim(),
      connectedOn: row['Connected On']?.trim(),
      location: undefined, // Not in LinkedIn export
      raw: row,
    }));
  }
}

// ─── GitHub API Parser ───
export class GitHubParser implements ImportSource {
  type = 'github' as const;
  
  async parse(username: string): Promise<RawContact[]> {
    const [followers, following, starred] = await Promise.all([
      this.fetchPaginated(`/users/${username}/followers`),
      this.fetchPaginated(`/users/${username}/following`),
      this.fetchPaginated(`/users/${username}/starred`),
    ]);
    
    // Merge and deduplicate
    const uniqueUsers = new Map<string, any>();
    [...followers, ...following].forEach(u => uniqueUsers.set(u.login, u));
    
    // Fetch full profiles (rate-limited)
    const contacts: RawContact[] = [];
    for (const [login, user] of uniqueUsers) {
      const full = await this.fetchUser(login);
      contacts.push({
        fullName: full.name || login,
        email: full.email || undefined,
        company: full.company?.replace(/^@/, '') || undefined,
        location: full.location || undefined,
        position: full.bio || undefined,
        linkedinUrl: undefined,
        raw: full,
      });
    }
    
    return contacts;
  }
  
  private async fetchPaginated(path: string): Promise<any[]> { /* ... */ }
  private async fetchUser(login: string): Promise<any> { /* ... */ }
}

// ─── Import Orchestrator ───
export class ImportPipeline extends EventEmitter {
  async run(source: ImportSource, input: Buffer | string) {
    this.emit('stage', 'parsing');
    const rawContacts = await source.parse(input);
    this.emit('parsed', { count: rawContacts.length });
    
    this.emit('stage', 'normalizing');
    const normalized = await this.normalize(rawContacts);
    this.emit('normalized', { count: normalized.length, duplicates: rawContacts.length - normalized.length });
    
    this.emit('stage', 'saving');
    const saved = await this.save(normalized, source.type);
    this.emit('saved', { count: saved.length });
    
    // Queue enrichment (async, non-blocking)
    this.emit('stage', 'queuing_enrichment');
    await this.queueEnrichment(saved.map(c => c.id));
    
    this.emit('complete', { total: saved.length });
    return saved;
  }
  
  private async normalize(raw: RawContact[]) { /* see 2.3 */ }
  private async save(contacts: NormalizedContact[], source: string) { /* batch insert */ }
  private async queueEnrichment(contactIds: string[]) { /* see 2.4 */ }
}
```

---

### 2.3 Stage 2: Normalization & Deduplication

```typescript
// packages/core/src/import/normalize.ts

export interface NormalizedContact {
  fullName: string;
  firstName: string;
  lastName: string;
  email?: string;
  company?: string;
  companyDomain?: string;
  role?: string;
  seniority?: Seniority;
  location?: string;
  country?: string;
  fingerprint: string; // Dedup key
}

type Seniority = 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'director' | 'vp' | 'c_level';

// ─── Name normalization ───
function normalizeName(raw: RawContact): { firstName: string; lastName: string; fullName: string } {
  const full = raw.fullName || `${raw.firstName ?? ''} ${raw.lastName ?? ''}`.trim();
  
  // Handle "Last, First" format
  const parts = full.includes(',') 
    ? full.split(',').reverse().map(s => s.trim())
    : full.split(/\s+/);
  
  return {
    firstName: raw.firstName || parts[0] || '',
    lastName: raw.lastName || parts.slice(1).join(' ') || '',
    fullName: full,
  };
}

// ─── Company normalization ───
function normalizeCompany(raw: string | undefined): { company?: string; domain?: string } {
  if (!raw) return {};
  
  // Remove common suffixes
  const cleaned = raw
    .replace(/,?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|GmbH|S\.A\.?|PLC)$/i, '')
    .trim();
  
  // Attempt domain extraction from known companies
  const domain = COMPANY_DOMAIN_MAP[cleaned.toLowerCase()] || undefined;
  
  return { company: cleaned, domain };
}

// ─── Title → Role + Seniority extraction ───
function normalizeTitle(title: string | undefined): { role?: string; seniority?: Seniority } {
  if (!title) return {};
  
  const seniorityMap: Array<[RegExp, Seniority]> = [
    [/\b(ceo|cto|cfo|coo|chief)\b/i, 'c_level'],
    [/\b(vp|vice president)\b/i, 'vp'],
    [/\b(director)\b/i, 'director'],
    [/\b(lead|principal|staff)\b/i, 'lead'],
    [/\b(senior|sr\.?)\b/i, 'senior'],
    [/\b(junior|jr\.?|associate)\b/i, 'junior'],
    [/\b(intern)\b/i, 'intern'],
  ];
  
  let seniority: Seniority = 'mid'; // Default
  for (const [pattern, level] of seniorityMap) {
    if (pattern.test(title)) { seniority = level; break; }
  }
  
  // Extract core role (remove seniority prefix)
  const role = title
    .replace(/\b(senior|sr\.?|junior|jr\.?|lead|principal|staff|chief|vp|vice president|director)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  return { role: role || title, seniority };
}

// ─── Deduplication via fingerprint ───
function generateFingerprint(contact: Partial<NormalizedContact>): string {
  // Priority: email > (name + company) > (name + linkedin)
  if (contact.email) {
    return `email:${contact.email.toLowerCase()}`;
  }
  
  const namePart = (contact.fullName || '').toLowerCase().replace(/[^a-z]/g, '');
  const companyPart = (contact.company || '').toLowerCase().replace(/[^a-z]/g, '');
  
  return `name:${namePart}|company:${companyPart}`;
}

// ─── Merge strategy for duplicates ───
export function mergeContacts(existing: NormalizedContact, incoming: NormalizedContact): NormalizedContact {
  return {
    ...existing,
    // Prefer non-null incoming values
    email: incoming.email || existing.email,
    company: incoming.company || existing.company,
    role: incoming.role || existing.role,
    location: incoming.location || existing.location,
    // Always take newer full name (may have been updated)
    fullName: incoming.fullName || existing.fullName,
  };
}
```

---

### 2.4 Stage 3: Enrichment Pipeline

```typescript
// packages/core/src/enrichment/pipeline.ts

export interface EnrichmentProvider {
  id: string;
  name: string;
  rateLimit: { requests: number; window: 'minute' | 'hour' | 'day' };
  priority: number;         // Lower = runs first
  cacheTTL: number;         // Seconds before re-enrichment
  
  canEnrich(contact: Contact): boolean;
  enrich(contact: Contact): Promise<EnrichmentResult>;
}

export interface EnrichmentResult {
  provider: string;
  confidence: number;       // 0-1
  data: Partial<{
    email: string;
    emailVerified: boolean;
    phone: string;
    company: string;
    companyDomain: string;
    role: string;
    seniority: string;
    location: string;
    country: string;
    linkedinUrl: string;
    githubUrl: string;
    twitterUrl: string;
    avatarUrl: string;
    skills: string[];
    experience: Array<{ company: string; role: string; from: string; to?: string }>;
  }>;
  rawPayload: Record<string, unknown>;
}

// ─── Hunter.io Provider ───
export class HunterProvider implements EnrichmentProvider {
  id = 'hunter';
  name = 'Hunter.io';
  rateLimit = { requests: 25, window: 'day' as const }; // Free tier
  priority = 1;
  cacheTTL = 30 * 86400; // 30 days
  
  canEnrich(contact: Contact): boolean {
    // Hunter needs company domain OR full name + company
    return !!(contact.companyDomain || (contact.fullName && contact.company));
  }
  
  async enrich(contact: Contact): Promise<EnrichmentResult> {
    const domain = contact.companyDomain || await this.findDomain(contact.company!);
    
    const response = await fetch(
      `https://api.hunter.io/v2/email-finder?domain=${domain}` +
      `&first_name=${contact.firstName}&last_name=${contact.lastName}` +
      `&api_key=${this.apiKey}`
    );
    
    const { data } = await response.json();
    
    return {
      provider: 'hunter',
      confidence: data.score / 100,
      data: {
        email: data.email,
        emailVerified: data.verification?.status === 'valid',
      },
      rawPayload: data,
    };
  }
  
  private async findDomain(company: string): Promise<string> {
    const res = await fetch(
      `https://api.hunter.io/v2/domain-search?company=${encodeURIComponent(company)}` +
      `&api_key=${this.apiKey}`
    );
    const { data } = await res.json();
    return data.domain;
  }
}

// ─── People Data Labs Provider ───
export class PDLProvider implements EnrichmentProvider {
  id = 'pdl';
  name = 'People Data Labs';
  rateLimit = { requests: 100, window: 'month' as const };
  priority = 2;
  cacheTTL = 60 * 86400; // 60 days
  
  canEnrich(contact: Contact): boolean {
    return !!(contact.linkedinUrl || contact.email || (contact.fullName && contact.company));
  }
  
  async enrich(contact: Contact): Promise<EnrichmentResult> {
    const params: Record<string, string> = {};
    if (contact.linkedinUrl) params.profile = contact.linkedinUrl;
    if (contact.email) params.email = contact.email;
    if (contact.fullName) params.name = contact.fullName;
    if (contact.company) params.company = contact.company;
    
    const response = await fetch('https://api.peopledatalabs.com/v5/person/enrich', {
      headers: { 'X-Api-Key': this.apiKey },
      method: 'GET',
      // ... params
    });
    
    const person = await response.json();
    
    return {
      provider: 'pdl',
      confidence: person.likelihood ?? 0.5,
      data: {
        email: person.work_email || person.personal_emails?.[0],
        company: person.job_company_name,
        role: person.job_title,
        seniority: this.mapSeniority(person.job_title_levels),
        location: person.location_name,
        country: person.location_country,
        linkedinUrl: person.linkedin_url,
        githubUrl: person.github_url,
        twitterUrl: person.twitter_url,
        skills: person.skills,
        experience: person.experience?.map((e: any) => ({
          company: e.company?.name,
          role: e.title?.name,
          from: e.start_date,
          to: e.end_date,
        })),
      },
      rawPayload: person,
    };
  }
}

// ─── Enrichment Orchestrator ───
export class EnrichmentPipeline {
  private providers: EnrichmentProvider[];
  private rateLimiter: RateLimiter;
  private cache: EnrichmentCache;
  
  constructor(config: { providers: EnrichmentProvider[]; db: Database }) {
    this.providers = config.providers.sort((a, b) => a.priority - b.priority);
    this.rateLimiter = new RateLimiter(config.providers);
    this.cache = new EnrichmentCache(config.db);
  }
  
  async enrichContact(contact: Contact, opts?: { force?: boolean; providers?: string[] }): Promise<Contact> {
    const results: EnrichmentResult[] = [];
    
    for (const provider of this.providers) {
      // Skip if filtered
      if (opts?.providers && !opts.providers.includes(provider.id)) continue;
      
      // Check cache
      if (!opts?.force) {
        const cached = await this.cache.get(contact.id, provider.id);
        if (cached && !cached.stale) {
          results.push(cached.result);
          continue;
        }
      }
      
      // Check rate limit
      if (!await this.rateLimiter.canProceed(provider.id)) {
        console.warn(`Rate limited: ${provider.name}`);
        continue;
      }
      
      // Check if provider can help with this contact
      if (!provider.canEnrich(contact)) continue;
      
      try {
        const result = await provider.enrich(contact);
        results.push(result);
        
        // Cache the result
        await this.cache.set(contact.id, provider.id, result, provider.cacheTTL);
        
        // Record rate limit usage
        await this.rateLimiter.record(provider.id);
      } catch (error) {
        console.error(`Enrichment failed [${provider.name}]:`, error);
      }
    }
    
    // Merge results (higher confidence wins per field)
    return this.mergeResults(contact, results);
  }
  
  async enrichBatch(contactIds: string[], opts?: { concurrency?: number }) {
    const concurrency = opts?.concurrency ?? 5;
    const queue = [...contactIds];
    const results: Map<string, Contact> = new Map();
    
    // Process in parallel with concurrency limit
    const workers = Array(concurrency).fill(null).map(async () => {
      while (queue.length > 0) {
        const id = queue.shift()!;
        const contact = await db.select().from(contacts).where(eq(contacts.id, id)).get();
        if (contact) {
          const enriched = await this.enrichContact(contact);
          results.set(id, enriched);
        }
      }
    });
    
    await Promise.all(workers);
    return results;
  }
  
  private mergeResults(contact: Contact, results: EnrichmentResult[]): Contact {
    const merged = { ...contact };
    
    // For each field, pick the highest-confidence value
    const fieldConfidence: Record<string, { value: any; confidence: number }> = {};
    
    for (const result of results) {
      for (const [key, value] of Object.entries(result.data)) {
        if (value === undefined || value === null) continue;
        const existing = fieldConfidence[key];
        if (!existing || result.confidence > existing.confidence) {
          fieldConfidence[key] = { value, confidence: result.confidence };
        }
      }
    }
    
    // Apply merged fields
    for (const [key, { value }] of Object.entries(fieldConfidence)) {
      (merged as any)[key] = value;
    }
    
    return merged;
  }
}
```

---

### 2.5 Stage 4: Search & Indexing

```typescript
// packages/core/src/search/engine.ts

export interface SearchEngine {
  index(contact: Contact): Promise<void>;
  search(query: SearchQuery): Promise<SearchResult[]>;
  suggest(partial: string): Promise<string[]>;
}

export interface SearchQuery {
  text?: string;           // Free-text query
  filters?: {
    company?: string[];
    role?: string[];
    seniority?: Seniority[];
    location?: string[];
    industry?: string[];
    tags?: string[];
    minScore?: number;
    hasEmail?: boolean;
    lastActiveWithin?: number; // days
  };
  sort?: 'relevance' | 'score' | 'recent' | 'name';
  limit?: number;
  offset?: number;
}

// ─── Hybrid Search (FTS5 + Vector) ───
export class HybridSearchEngine implements SearchEngine {
  
  async index(contact: Contact): Promise<void> {
    // 1. Update FTS5 index
    const searchText = [
      contact.fullName,
      contact.headline,
      contact.company,
      contact.role,
      contact.location,
      (contact.tags || []).join(' '),
      contact.notes,
    ].filter(Boolean).join(' | ');
    
    await db.insert(searchIndex).values({
      contactId: contact.id,
      searchText,
      companyNorm: contact.company?.toLowerCase(),
      roleNorm: contact.role?.toLowerCase(),
      locationNorm: contact.location?.toLowerCase(),
      seniorityNorm: contact.seniority,
      industryNorm: contact.industry?.toLowerCase(),
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: searchIndex.contactId,
      set: { searchText, updatedAt: new Date().toISOString() },
    });
    
    // 2. Generate embedding (async, non-blocking for import speed)
    this.queueEmbedding(contact.id, searchText);
  }
  
  async search(query: SearchQuery): Promise<SearchResult[]> {
    // Strategy: FTS5 for keyword matches + vector similarity for semantic
    // Then merge and re-rank
    
    const [keywordResults, semanticResults] = await Promise.all([
      query.text ? this.keywordSearch(query.text, query.limit ?? 50) : [],
      query.text ? this.semanticSearch(query.text, query.limit ?? 50) : [],
    ]);
    
    // Merge with RRF (Reciprocal Rank Fusion)
    const merged = this.reciprocalRankFusion(keywordResults, semanticResults);
    
    // Apply filters
    const filtered = await this.applyFilters(merged, query.filters);
    
    // Sort
    return this.sort(filtered, query.sort ?? 'relevance')
      .slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50));
  }
  
  private async keywordSearch(text: string, limit: number): Promise<ScoredContact[]> {
    const results = await db.all(sql`
      SELECT contact_id, rank
      FROM contacts_fts
      WHERE contacts_fts MATCH ${this.buildFTSQuery(text)}
      ORDER BY rank
      LIMIT ${limit}
    `);
    
    return results.map(r => ({ contactId: r.contact_id, score: -r.rank }));
  }
  
  private async semanticSearch(text: string, limit: number): Promise<ScoredContact[]> {
    // Generate query embedding
    const queryEmbedding = await this.embed(text);
    
    // Cosine similarity against stored embeddings
    // (In production, use pgvector extension for Postgres or sqlite-vss for SQLite)
    const allEmbeddings = await db.select({
      contactId: searchIndex.contactId,
      embedding: searchIndex.embedding,
    }).from(searchIndex).where(sql`${searchIndex.embedding} IS NOT NULL`);
    
    const scored = allEmbeddings
      .map(row => ({
        contactId: row.contactId,
        score: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding!)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    return scored;
  }
  
  private reciprocalRankFusion(
    ...resultSets: ScoredContact[][]
  ): ScoredContact[] {
    const k = 60; // RRF constant
    const scores = new Map<string, number>();
    
    for (const results of resultSets) {
      results.forEach((result, rank) => {
        const rrf = 1 / (k + rank + 1);
        scores.set(result.contactId, (scores.get(result.contactId) ?? 0) + rrf);
      });
    }
    
    return Array.from(scores.entries())
      .map(([contactId, score]) => ({ contactId, score }))
      .sort((a, b) => b.score - a.score);
  }
  
  private buildFTSQuery(text: string): string {
    // Convert natural language to FTS5 syntax
    // "senior engineer at stripe" → "senior AND engineer AND stripe"
    const terms = text.split(/\s+/).filter(t => t.length > 1);
    return terms.map(t => `"${t}"*`).join(' OR ');
  }
  
  private async embed(text: string): Promise<number[]> {
    // Uses BYO key — supports OpenAI, Ollama, or local model
    const provider = getEmbeddingProvider(); // From user config
    return provider.embed(text);
  }
}
```

---

### 2.6 Stage 5: Analytics & Scoring Engine

```typescript
// packages/core/src/analytics/scoring.ts

export interface NetworkMetrics {
  totalContacts: number;
  activeConnections: number;     // Interacted within 30 days
  dormantConnections: number;    // No interaction in 90+ days
  networkScore: number;          // 0-100 composite score
  growthRate: number;            // % change last 30 days
  diversityScore: number;       // Industry/role spread
  reachability: number;         // Avg shortest path to all nodes
  clusterCount: number;         // Number of detected communities
  topClusters: ClusterInfo[];
  weakTies: Contact[];          // Bridge nodes between clusters
}

// ─── Relationship Scoring Algorithm ───
export function computeRelationshipScore(contact: Contact, interactions: Interaction[]): number {
  let score = 0;
  
  // Factor 1: Recency (40% weight)
  const lastInteraction = interactions[0]?.occurredAt;
  if (lastInteraction) {
    const daysSince = daysBetween(new Date(lastInteraction), new Date());
    const recencyScore = Math.max(0, 100 - (daysSince * 0.5)); // Decays 0.5/day
    score += recencyScore * 0.4;
  }
  
  // Factor 2: Frequency (25% weight)
  const interactionsLast90Days = interactions.filter(
    i => daysBetween(new Date(i.occurredAt), new Date()) <= 90
  ).length;
  const frequencyScore = Math.min(100, interactionsLast90Days * 15); // Cap at ~7 interactions
  score += frequencyScore * 0.25;
  
  // Factor 3: Depth (20% weight) — bidirectional communication is stronger
  const outbound = interactions.filter(i => i.direction === 'outbound').length;
  const inbound = interactions.filter(i => i.direction === 'inbound').length;
  const ratio = Math.min(outbound, inbound) / Math.max(outbound, inbound, 1);
  const depthScore = ratio * 100;
  score += depthScore * 0.2;
  
  // Factor 4: Richness (15% weight) — diverse interaction types
  const uniqueTypes = new Set(interactions.map(i => i.type)).size;
  const richnessScore = Math.min(100, uniqueTypes * 25); // 4 types = max
  score += richnessScore * 0.15;
  
  return Math.round(Math.min(100, Math.max(0, score)));
}

// ─── Network Health Score ───
export function computeNetworkScore(metrics: {
  totalContacts: number;
  activeRate: number;          // % with interaction in 30 days
  diversityIndex: number;     // Shannon entropy of industries
  clusterBridges: number;     // Contacts connecting different clusters
  growthRate: number;          // New contacts per month
}): number {
  const weights = {
    size: 0.15,        // Having a big network matters somewhat
    activity: 0.30,    // Active relationships matter most
    diversity: 0.25,   // Diverse network = more opportunities
    structure: 0.20,   // Well-connected structure (bridges)
    growth: 0.10,      // Steady growth
  };
  
  const sizeScore = Math.min(100, (metrics.totalContacts / 500) * 100);
  const activityScore = metrics.activeRate * 100;
  const diversityScore = metrics.diversityIndex * 100; // Normalized 0-1
  const structureScore = Math.min(100, metrics.clusterBridges * 10);
  const growthScore = Math.min(100, metrics.growthRate * 5); // 20/mo = max
  
  return Math.round(
    sizeScore * weights.size +
    activityScore * weights.activity +
    diversityScore * weights.diversity +
    structureScore * weights.structure +
    growthScore * weights.growth
  );
}

// ─── Cluster Detection (Louvain Algorithm via graphology) ───
export async function detectClusters(db: Database): Promise<ClusterInfo[]> {
  const Graph = await import('graphology');
  const { louvain } = await import('graphology-communities-louvain');
  
  const graph = new Graph.default();
  
  // Load nodes
  const allContacts = await db.select({ id: contacts.id, company: contacts.company })
    .from(contacts).where(sql`deleted_at IS NULL`);
  
  allContacts.forEach(c => graph.addNode(c.id, { company: c.company }));
  
  // Load edges
  const allEdges = await db.select().from(edges);
  allEdges.forEach(e => {
    if (graph.hasNode(e.sourceId) && graph.hasNode(e.targetId)) {
      graph.addEdge(e.sourceId, e.targetId, { weight: e.strength });
    }
  });
  
  // Run community detection
  const communities = louvain(graph, { resolution: 1.0 });
  
  // Group by community
  const clusters = new Map<number, string[]>();
  for (const [nodeId, communityId] of Object.entries(communities)) {
    if (!clusters.has(communityId)) clusters.set(communityId, []);
    clusters.get(communityId)!.push(nodeId);
  }
  
  // Analyze each cluster
  return Array.from(clusters.entries()).map(([id, members]) => ({
    id,
    size: members.length,
    topCompanies: extractTopCompanies(members, allContacts),
    density: computeClusterDensity(members, allEdges),
  }));
}
```

---

### 2.7 Stage 6: Job Queue & Scheduling

```typescript
// packages/core/src/jobs/scheduler.ts

// For serverless (Vercel): use Inngest
// For self-hosted: use BullMQ + Redis

import { Inngest } from 'inngest';

export const inngest = new Inngest({ id: 'netpro' });

// ─── Enrichment Job ───
export const enrichContactJob = inngest.createFunction(
  { id: 'enrich-contact', concurrency: { limit: 5 } },
  { event: 'contact/enrich.requested' },
  async ({ event, step }) => {
    const { contactId, providers } = event.data;
    
    const contact = await step.run('fetch-contact', async () => {
      return db.select().from(contacts).where(eq(contacts.id, contactId)).get();
    });
    
    if (!contact) return { status: 'not_found' };
    
    const enriched = await step.run('enrich', async () => {
      const pipeline = new EnrichmentPipeline({ providers: getActiveProviders() });
      return pipeline.enrichContact(contact, { providers });
    });
    
    await step.run('save', async () => {
      await db.update(contacts).set(enriched).where(eq(contacts.id, contactId));
    });
    
    await step.run('reindex', async () => {
      const engine = new HybridSearchEngine();
      await engine.index(enriched);
    });
    
    return { status: 'enriched', contactId };
  }
);

// ─── Batch Enrichment ───
export const batchEnrichJob = inngest.createFunction(
  { id: 'batch-enrich', concurrency: { limit: 1 } },
  { event: 'contacts/batch-enrich.requested' },
  async ({ event, step }) => {
    const { contactIds } = event.data;
    
    // Fan out to individual enrichment jobs
    for (const id of contactIds) {
      await step.sendEvent('queue-enrich', {
        name: 'contact/enrich.requested',
        data: { contactId: id },
      });
      
      // Respect rate limits
      await step.sleep('rate-limit-delay', '2s');
    }
    
    return { status: 'queued', count: contactIds.length };
  }
);

// ─── Relationship Score Decay (daily cron) ───
export const scoreDecayJob = inngest.createFunction(
  { id: 'score-decay' },
  { cron: '0 2 * * *' }, // 2 AM daily
  async ({ step }) => {
    await step.run('decay-scores', async () => {
      await decayRelationshipScores();
    });
    
    await step.run('identify-dormant', async () => {
      const dormant = await getDormantConnections(90);
      if (dormant.length > 0) {
        // Create follow-up suggestions
        for (const contact of dormant.slice(0, 5)) {
          await db.insert(followUps).values({
            id: nanoid(),
            contactId: contact.id,
            reason: `Haven't connected in 90+ days. Relationship score dropping.`,
            dueAt: new Date().toISOString(),
            status: 'pending',
          });
        }
      }
    });
  }
);

// ─── Campaign Sender (runs every 15 min) ───
export const campaignSenderJob = inngest.createFunction(
  { id: 'campaign-sender' },
  { cron: '*/15 * * * *' },
  async ({ step }) => {
    const pending = await step.run('get-pending', async () => {
      return db.select()
        .from(campaignRecipients)
        .where(and(
          eq(campaignRecipients.status, 'scheduled'),
          sql`${campaignRecipients.scheduledAt} <= datetime('now')`
        ))
        .limit(10); // Process 10 at a time
    });
    
    for (const recipient of pending) {
      await step.run(`send-${recipient.id}`, async () => {
        await sendCampaignEmail(recipient);
        await db.update(campaignRecipients)
          .set({ status: 'sent', sentAt: new Date().toISOString() })
          .where(eq(campaignRecipients.id, recipient.id));
      });
      
      // Jitter to avoid spam detection
      await step.sleep('jitter', `${Math.random() * 30}s`);
    }
  }
);
```

---

### 2.8 Data Flow: End-to-End Example

```
User: "netpro import --linkedin connections.csv"

┌──────────────────────────────────────────────────────────────────────────┐
│ STEP 1: PARSE                                                            │
│ LinkedInCSVParser reads CSV → produces 847 RawContact objects             │
│ Time: ~200ms                                                             │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ STEP 2: NORMALIZE                                                        │
│ • Name normalization → "Smith, John" → { first: "John", last: "Smith" } │
│ • Company normalization → "Google, Inc." → "Google" (domain: google.com) │
│ • Title extraction → "Sr. Product Manager" → role: "Product Manager",   │
│   seniority: "senior"                                                    │
│ • Fingerprint generation → "email:john@google.com"                       │
│ Time: ~500ms                                                             │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ STEP 3: DEDUPLICATE                                                      │
│ • Check fingerprints against existing DB contacts                        │
│ • 23 duplicates found → merge strategy applied                           │
│ • 824 new contacts + 23 updates = 847 total processed                    │
│ Time: ~1s                                                                │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ STEP 4: PERSIST                                                          │
│ • Batch INSERT INTO contacts (824 rows)                                  │
│ • Batch UPDATE contacts (23 rows)                                        │
│ • Create edges for mutual connections (if data available)                │
│ • Insert into activity_log                                               │
│ Time: ~300ms (SQLite transaction)                                        │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ STEP 5: INDEX                                                            │
│ • Update FTS5 virtual table (all 847 contacts)                           │
│ • Queue embedding generation (async, background)                         │
│ • Update facet fields in search_index table                              │
│ Time: ~400ms (FTS), embeddings queued for background                     │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ STEP 6: ENRICH (background, async)                                       │
│ • Queue enrichment for contacts missing email (412 contacts)             │
│ • Rate-limited: 25/day (Hunter free tier)                                │
│ • Will complete in ~17 days at free tier rate                            │
│ • Each enriched contact triggers re-indexing                             │
│ Time: Ongoing background process                                         │
└──────────────────────────────────────────────────────────────────────────┘

Total interactive time: ~2.5 seconds
User sees: "✓ Imported 847 contacts (23 merged, 824 new). Enrichment queued."
```

---

### 2.9 CLI ↔ Web Data Sync (Optional)

```
┌─────────────────────────────────────────────────────────────────┐
│                     SYNC ARCHITECTURE                            │
│                                                                 │
│  ┌──────────┐          ┌──────────────┐          ┌──────────┐ │
│  │   CLI    │ ◀──────▶ │   Sync API   │ ◀──────▶ │   Web    │ │
│  │ (SQLite) │  HTTP/WS  │ (Serverless) │  Realtime │(Supabase)│ │
│  └──────────┘          └──────────────┘          └──────────┘ │
│                                                                 │
│  Strategy: CRDTs (Conflict-free Replicated Data Types)          │
│  • Each record has a vector clock (updated_at + device_id)     │
│  • Last-write-wins for simple fields                           │
│  • Merge for arrays (tags, interactions)                       │
│  • Tombstones for deletes (soft delete with 30-day TTL)        │
│                                                                 │
│  Sync triggers:                                                 │
│  • CLI: `netpro sync` (manual) or on-write (if online)        │
│  • Web: Real-time via Supabase subscriptions                   │
│  • Conflict resolution: prompt user in CLI, auto-merge in web  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### 2.10 Performance Budgets

| Operation | Target | Approach |
|-----------|--------|----------|
| Import 1000 contacts | < 3s | Batch inserts, deferred indexing |
| Full-text search | < 50ms | FTS5 with pre-built index |
| Semantic search | < 200ms | pgvector (Postgres) or sqlite-vss (SQLite) |
| Enrichment (single) | < 2s | Parallel provider calls |
| Network graph render | < 1s | Pre-computed layout, WebGL (large graphs) |
| Dashboard load | < 500ms | Denormalized stats table, ISR (Next.js) |
| Campaign send | < 5s/email | Queued, jittered, rate-limited |
| Path finding (BFS) | < 500ms for 10K nodes | In-memory graph (graphology) |

---

### 2.11 Backup & Data Portability

```typescript
// packages/core/src/export/backup.ts

export async function createFullBackup(): Promise<Buffer> {
  const backup = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    data: {
      contacts: await db.select().from(contacts),
      interactions: await db.select().from(interactions),
      edges: await db.select().from(edges),
      campaigns: await db.select().from(campaigns),
      campaignRecipients: await db.select().from(campaignRecipients),
      followUps: await db.select().from(followUps),
      enrichments: await db.select().from(enrichments),
    },
    metadata: {
      totalContacts: await db.select({ count: sql`count(*)` }).from(contacts),
      schemaVersion: CURRENT_SCHEMA_VERSION,
    },
  };
  
  // Compress with gzip
  return gzip(JSON.stringify(backup));
}

// Export formats
export async function exportContacts(opts: {
  format: 'csv' | 'json' | 'vcard';
  filter?: SearchQuery;
}): Promise<string | Buffer> {
  const results = opts.filter 
    ? await searchEngine.search(opts.filter)
    : await db.select().from(contacts);
  
  switch (opts.format) {
    case 'csv':   return toCSV(results);
    case 'json':  return JSON.stringify(results, null, 2);
    case 'vcard': return toVCard(results);
  }
}
```

---

*This schema and pipeline are designed to scale from 100 contacts (solo CLI user) to 100K+ contacts (team SaaS deployment) without architectural changes — only infrastructure scaling (SQLite → Postgres, local queue → Inngest).*
