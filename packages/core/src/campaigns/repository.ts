// packages/core/src/campaigns/repository.ts
//
// Campaign persistence: creation (with a recipient snapshot from explicit
// ids or a resolved search), the draft-only edit window, the lifecycle
// transition matrix, and self-healing stats recomputed from the recipient
// rows. JSON columns are json-mode on SQLite and plain text on Postgres —
// every write branch encodes for its dialect, and `parseJsonColumn` is the
// single read seam.
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { writeActivityLog } from '../crm/activity';
import { CrmError, optionalText, resolveNow, type CrmOptions } from '../crm/types';
import { searchContacts } from '../search/query';
import { validateDripSteps, validateMessageTemplate } from './template';
import {
  CAMPAIGN_LIMITS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TRANSITIONS,
  type Campaign,
  type CampaignStatus,
  type CampaignType,
  type DripStep,
  type MessageTemplate,
  type RecipientSelection,
} from './types';

/** Parse a JSON-ish column value from either dialect, with a fallback. */
export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

/**
 * Per-dialect column map for campaign rows. Drizzle's typed builders need
 * dialect-narrowed tables (the load-bearing `conn.dialect` narrowing used
 * across the core modules); both selects are the same ANSI query.
 */
function campaignColumnsSqlite(conn: SqliteConn) {
  const c = conn.schema.campaigns;
  return {
    id: c.id, name: c.name, description: c.description, status: c.status, type: c.type,
    template: c.template, steps: c.steps, sendFrom: c.sendFrom, sendVia: c.sendVia,
    dailyLimit: c.dailyLimit, totalRecipients: c.totalRecipients, sent: c.sent,
    opened: c.opened, replied: c.replied, bounced: c.bounced,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}
function campaignColumnsPg(conn: PgConn) {
  const c = conn.schema.campaigns;
  return {
    id: c.id, name: c.name, description: c.description, status: c.status, type: c.type,
    template: c.template, steps: c.steps, sendFrom: c.sendFrom, sendVia: c.sendVia,
    dailyLimit: c.dailyLimit, totalRecipients: c.totalRecipients, sent: c.sent,
    opened: c.opened, replied: c.replied, bounced: c.bounced,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

interface CampaignDbRow {
  id: string;
  name: string;
  description: string | null;
  status: string | null;
  type: string | null;
  template: unknown;
  steps: unknown;
  sendFrom: string | null;
  sendVia: string | null;
  dailyLimit: number | null;
  totalRecipients: number | null;
  sent: number | null;
  opened: number | null;
  replied: number | null;
  bounced: number | null;
  createdAt: string;
  updatedAt: string;
}

export function normalizeCampaign(row: CampaignDbRow): Campaign {
  const status = CAMPAIGN_STATUSES.includes(row.status as CampaignStatus)
    ? (row.status as CampaignStatus)
    : 'draft';
  const steps = parseJsonColumn<DripStep[]>(row.steps, []);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status,
    type: row.type === 'sequence' ? 'sequence' : 'single',
    template: parseJsonColumn<MessageTemplate>(row.template, { subject: '', body: '' }),
    steps: Array.isArray(steps) ? steps : [],
    sendFrom: row.sendFrom,
    sendVia: row.sendVia,
    dailyLimit: row.dailyLimit ?? 50,
    totalRecipients: row.totalRecipients ?? 0,
    sent: row.sent ?? 0,
    opened: row.opened ?? 0,
    replied: row.replied ?? 0,
    bounced: row.bounced ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function selectCampaign(
  conn: SqliteConn | PgConn,
  id: string
): Promise<CampaignDbRow | null> {
  if (conn.dialect === 'sqlite') {
    const c = conn.schema.campaigns;
    const rows = await conn.db.select(campaignColumnsSqlite(conn)).from(c).where(eq(c.id, id));
    return (rows[0] as CampaignDbRow | undefined) ?? null;
  }
  const c = conn.schema.campaigns;
  const rows = await conn.db.select(campaignColumnsPg(conn)).from(c).where(eq(c.id, id));
  return (rows[0] as CampaignDbRow | undefined) ?? null;
}

export async function getCampaign(
  conn: SqliteConn | PgConn,
  id: string
): Promise<Campaign | null> {
  const row = await selectCampaign(conn, id.trim());
  return row ? normalizeCampaign(row) : null;
}

export interface CreateCampaignInput {
  name: string;
  description?: string | null;
  sendFrom?: string | null;
  dailyLimit?: number | null;
  template: unknown;
  steps?: unknown;
  recipients?: RecipientSelection;
}

export interface CreateCampaignResult {
  campaign: Campaign;
  added: number;
  skippedDuplicates: number;
}

function validateDailyLimit(value: unknown): number {
  if (value === undefined || value === null) return 50;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > CAMPAIGN_LIMITS.dailyLimitMax
  ) {
    throw new CrmError(
      'invalid_input',
      `dailyLimit must be a whole number between 1 and ${CAMPAIGN_LIMITS.dailyLimitMax}.`
    );
  }
  return value;
}

/**
 * Create a draft campaign. When `recipients.search` is given, the search is
 * resolved to concrete contact ids *now* — a campaign commits to a list, not
 * to a live query (Phase 8 design spec).
 */
export async function createCampaign(
  conn: SqliteConn | PgConn,
  input: CreateCampaignInput,
  opts: CrmOptions = {}
): Promise<CreateCampaignResult> {
  const now = resolveNow(opts);
  const name = optionalText(input.name, CAMPAIGN_LIMITS.name, 'name');
  if (!name) {
    throw new CrmError('invalid_input', 'A campaign name is required.');
  }
  const description = optionalText(input.description, CAMPAIGN_LIMITS.description, 'description') ?? null;
  const sendFrom = optionalText(input.sendFrom, CAMPAIGN_LIMITS.sendFrom, 'sendFrom') ?? null;
  const dailyLimit = validateDailyLimit(input.dailyLimit);
  const template = validateMessageTemplate(input.template, 'template');
  const steps = validateDripSteps(input.steps);
  const type: CampaignType = steps.length > 0 ? 'sequence' : 'single';

  const row = {
    id: randomUUID(),
    name,
    description,
    status: 'draft' as const,
    type,
    sendFrom,
    sendVia: null,
    dailyLimit,
    totalRecipients: 0,
    sent: 0,
    opened: 0,
    replied: 0,
    bounced: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (conn.dialect === 'sqlite') {
    // SQLite json-mode columns take objects; Postgres text columns take strings.
    await conn.db.insert(conn.schema.campaigns).values({ ...row, template, steps });
  } else {
    await conn.db
      .insert(conn.schema.campaigns)
      .values({ ...row, template: JSON.stringify(template), steps: JSON.stringify(steps) });
  }

  let added = 0;
  let skippedDuplicates = 0;
  if (input.recipients) {
    const result = await addRecipients(conn, row.id, input.recipients, { now });
    added = result.added;
    skippedDuplicates = result.skippedDuplicates;
  }

  await writeActivityLog(conn, {
    action: 'campaign.created',
    entityType: 'campaign',
    entityId: row.id,
    metadata: { name, type, recipientsAdded: added },
  });

  const campaign = (await getCampaign(conn, row.id))!;
  return { campaign, added, skippedDuplicates };
}

export interface AddRecipientsResult {
  added: number;
  skippedDuplicates: number;
}

/**
 * Add recipients from explicit contact ids and/or a search snapshot.
 * Duplicates (already on the campaign) are skipped, unknown or soft-deleted
 * ids are rejected with the offending list, and the per-campaign recipient
 * cap is enforced before any insert.
 */
export async function addRecipients(
  conn: SqliteConn | PgConn,
  campaignId: string,
  selection: RecipientSelection,
  opts: CrmOptions = {}
): Promise<AddRecipientsResult> {
  const now = resolveNow(opts);
  const campaign = await getCampaign(conn, campaignId);
  if (!campaign) throw new CrmError('not_found', `No campaign with id "${campaignId}".`);

  const ids: string[] = [];

  const explicit = (selection.contactIds ?? [])
    .map((id) => String(id).trim())
    .filter((id) => id.length > 0);
  if (explicit.length > 0) {
    const unique = [...new Set(explicit)];
    const found = await existingContactIds(conn, unique);
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new CrmError(
        'not_found',
        `Unknown or deleted contact${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`
      );
    }
    ids.push(...unique);
  }

  if (selection.search) {
    const remaining = CAMPAIGN_LIMITS.recipients - ids.length;
    if (remaining > 0) {
      const already = new Set(ids);
      let offset = Math.max(selection.search.offset ?? 0, 0);
      while (ids.length < CAMPAIGN_LIMITS.recipients) {
        const page = await searchContacts(conn, { ...selection.search, limit: 100, offset });
        for (const contact of page.contacts) {
          if (!already.has(contact.id)) {
            already.add(contact.id);
            ids.push(contact.id);
            if (ids.length >= CAMPAIGN_LIMITS.recipients) break;
          }
        }
        offset += 100;
        if (offset >= page.total || page.contacts.length === 0) break;
      }
    }
  }

  const existing = await recipientContactIds(conn, campaignId);
  const fresh = ids.filter((id) => !existing.has(id));
  const skippedDuplicates = ids.length - fresh.length;

  // The cap counts recipient ROWS (not distinct contact ids) so the guard
  // holds even against hand-edited data.
  const existingCount = await countRecipientRows(conn, campaignId);
  if (existingCount + fresh.length > CAMPAIGN_LIMITS.recipients) {
    throw new CrmError(
      'invalid_input',
      `A campaign holds at most ${CAMPAIGN_LIMITS.recipients} recipients (already ${existingCount}).`
    );
  }

  if (fresh.length > 0) {
    const rows = fresh.map((contactId) => ({
      id: randomUUID(),
      campaignId,
      contactId,
      status: 'pending' as const,
      currentStep: 0,
      personalizedVars: null,
      scheduledAt: null,
      sentAt: null,
      openedAt: null,
      repliedAt: null,
      bouncedAt: null,
      errorMessage: null,
    }));
    if (conn.dialect === 'sqlite') {
      await conn.db.insert(conn.schema.campaignRecipients).values(rows);
    } else {
      await conn.db.insert(conn.schema.campaignRecipients).values(rows);
    }
  }

  await refreshCampaignStats(conn, campaignId, now);
  await writeActivityLog(conn, {
    action: 'campaign.recipients_added',
    entityType: 'campaign',
    entityId: campaignId,
    metadata: { added: fresh.length, skippedDuplicates },
  });

  return { added: fresh.length, skippedDuplicates };
}

async function existingContactIds(
  conn: SqliteConn | PgConn,
  ids: string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  if (conn.dialect === 'sqlite') {
    const c = conn.schema.contacts;
    const rows = await conn.db
      .select({ id: c.id })
      .from(c)
      .where(and(inArray(c.id, ids), isNull(c.deletedAt)));
    return new Set(rows.map((r) => r.id));
  }
  const c = conn.schema.contacts;
  const rows = await conn.db
    .select({ id: c.id })
    .from(c)
    .where(and(inArray(c.id, ids), isNull(c.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

async function countRecipientRows(
  conn: SqliteConn | PgConn,
  campaignId: string
): Promise<number> {
  if (conn.dialect === 'sqlite') {
    const r = conn.schema.campaignRecipients;
    const rows = await conn.db
      .select({ n: sql<number>`count(*)` })
      .from(r)
      .where(eq(r.campaignId, campaignId));
    return Number(rows[0]?.n ?? 0);
  }
  const r = conn.schema.campaignRecipients;
  const rows = await conn.db
    .select({ n: sql<number>`count(*)` })
    .from(r)
    .where(eq(r.campaignId, campaignId));
  return Number(rows[0]?.n ?? 0);
}

async function recipientContactIds(
  conn: SqliteConn | PgConn,
  campaignId: string
): Promise<Set<string>> {
  if (conn.dialect === 'sqlite') {
    const r = conn.schema.campaignRecipients;
    const rows = await conn.db
      .select({ contactId: r.contactId })
      .from(r)
      .where(eq(r.campaignId, campaignId));
    return new Set(rows.map((r2) => r2.contactId));
  }
  const r = conn.schema.campaignRecipients;
  const rows = await conn.db
    .select({ contactId: r.contactId })
    .from(r)
    .where(eq(r.campaignId, campaignId));
  return new Set(rows.map((r2) => r2.contactId));
}

export interface ListCampaignsOptions {
  status?: CampaignStatus | string;
  limit?: number;
  offset?: number;
}

export interface CampaignsPage {
  campaigns: Campaign[];
  total: number;
  limit: number;
  offset: number;
}

export async function listCampaigns(
  conn: SqliteConn | PgConn,
  options: ListCampaignsOptions = {}
): Promise<CampaignsPage> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const status = CAMPAIGN_STATUSES.includes(options.status as CampaignStatus)
    ? (options.status as CampaignStatus)
    : undefined;

  if (conn.dialect === 'sqlite') {
    const c = conn.schema.campaigns;
    const where = status ? eq(c.status, status) : undefined;
    const rows = await conn.db
      .select(campaignColumnsSqlite(conn))
      .from(c)
      .where(where)
      .orderBy(desc(c.updatedAt))
      .limit(limit)
      .offset(offset);
    const counted = await conn.db
      .select({ n: sql<number>`count(*)` })
      .from(c)
      .where(where);
    return {
      campaigns: (rows as CampaignDbRow[]).map(normalizeCampaign),
      total: Number(counted[0]?.n ?? 0),
      limit,
      offset,
    };
  }
  const c = conn.schema.campaigns;
  const where = status ? eq(c.status, status) : undefined;
  const rows = await conn.db
    .select(campaignColumnsPg(conn))
    .from(c)
    .where(where)
    .orderBy(desc(c.updatedAt))
    .limit(limit)
    .offset(offset);
  const counted = await conn.db
    .select({ n: sql<number>`count(*)` })
    .from(c)
    .where(where);
  return {
    campaigns: (rows as CampaignDbRow[]).map(normalizeCampaign),
    total: Number(counted[0]?.n ?? 0),
    limit,
    offset,
  };
}

export interface UpdateCampaignDraftInput {
  name?: unknown;
  description?: unknown;
  sendFrom?: unknown;
  dailyLimit?: unknown;
  template?: unknown;
  steps?: unknown;
}

/**
 * Edit a campaign — only while it is a draft. Once active, the template
 * people are being sent from is frozen (paused campaigns can still be
 * archived or completed, but not rewritten mid-flight).
 */
export async function updateCampaignDraft(
  conn: SqliteConn | PgConn,
  id: string,
  patch: UpdateCampaignDraftInput,
  opts: CrmOptions = {}
): Promise<Campaign> {
  const now = resolveNow(opts);
  const campaign = await getCampaign(conn, id);
  if (!campaign) throw new CrmError('not_found', `No campaign with id "${id}".`);
  if (campaign.status !== 'draft') {
    throw new CrmError(
      'conflict',
      `Campaign "${campaign.name}" is ${campaign.status} — only draft campaigns can be edited.`
    );
  }

  const scalarUpdates: {
    updatedAt: string;
    name?: string;
    description?: string | null;
    sendFrom?: string | null;
    dailyLimit?: number;
    type?: CampaignType;
  } = { updatedAt: now.toISOString() };
  if (patch.name !== undefined) {
    const name = optionalText(patch.name, CAMPAIGN_LIMITS.name, 'name');
    if (!name) throw new CrmError('invalid_input', 'A campaign name is required.');
    scalarUpdates.name = name;
  }
  if (patch.description !== undefined) {
    scalarUpdates.description =
      optionalText(patch.description, CAMPAIGN_LIMITS.description, 'description') ?? null;
  }
  if (patch.sendFrom !== undefined) {
    scalarUpdates.sendFrom = optionalText(patch.sendFrom, CAMPAIGN_LIMITS.sendFrom, 'sendFrom') ?? null;
  }
  if (patch.dailyLimit !== undefined) scalarUpdates.dailyLimit = validateDailyLimit(patch.dailyLimit);

  let templatePatch: MessageTemplate | undefined;
  let stepsPatch: DripStep[] | undefined;
  if (patch.template !== undefined) {
    templatePatch = validateMessageTemplate(patch.template, 'template');
  }
  if (patch.steps !== undefined) {
    stepsPatch = validateDripSteps(patch.steps);
    scalarUpdates.type = stepsPatch.length > 0 ? 'sequence' : 'single';
  }

  if (conn.dialect === 'sqlite') {
    // SQLite json-mode columns take objects; Postgres text columns take strings.
    await conn.db
      .update(conn.schema.campaigns)
      .set({
        ...scalarUpdates,
        ...(templatePatch ? { template: templatePatch } : {}),
        ...(stepsPatch ? { steps: stepsPatch } : {}),
      })
      .where(eq(conn.schema.campaigns.id, campaign.id));
  } else {
    await conn.db
      .update(conn.schema.campaigns)
      .set({
        ...scalarUpdates,
        ...(templatePatch ? { template: JSON.stringify(templatePatch) } : {}),
        ...(stepsPatch ? { steps: JSON.stringify(stepsPatch) } : {}),
      })
      .where(eq(conn.schema.campaigns.id, campaign.id));
  }

  await writeActivityLog(conn, {
    action: 'campaign.updated',
    entityType: 'campaign',
    entityId: campaign.id,
    metadata: { fields: Object.keys(patch) },
  });

  return (await getCampaign(conn, campaign.id))!;
}

/** Validate and apply a lifecycle transition. */
export async function setCampaignStatus(
  conn: SqliteConn | PgConn,
  id: string,
  status: string,
  opts: CrmOptions = {}
): Promise<Campaign> {
  const now = resolveNow(opts);
  if (!CAMPAIGN_STATUSES.includes(status as CampaignStatus)) {
    throw new CrmError(
      'invalid_input',
      `Unknown campaign status "${status}". Expected one of: ${CAMPAIGN_STATUSES.join(', ')}.`
    );
  }
  const campaign = await getCampaign(conn, id);
  if (!campaign) throw new CrmError('not_found', `No campaign with id "${id}".`);

  const next = status as CampaignStatus;
  if (!CAMPAIGN_TRANSITIONS[campaign.status].includes(next)) {
    throw new CrmError(
      'conflict',
      `Cannot move a campaign from "${campaign.status}" to "${next}". Allowed: ${CAMPAIGN_TRANSITIONS[campaign.status].join(', ') || 'nothing (archived is final)'}.`
    );
  }

  if (conn.dialect === 'sqlite') {
    await conn.db
      .update(conn.schema.campaigns)
      .set({ status: next, updatedAt: now.toISOString() })
      .where(eq(conn.schema.campaigns.id, campaign.id));
  } else {
    await conn.db
      .update(conn.schema.campaigns)
      .set({ status: next, updatedAt: now.toISOString() })
      .where(eq(conn.schema.campaigns.id, campaign.id));
  }

  await writeActivityLog(conn, {
    action: 'campaign.status_changed',
    entityType: 'campaign',
    entityId: campaign.id,
    metadata: { from: campaign.status, to: next },
  });

  return (await getCampaign(conn, campaign.id))!;
}

/**
 * Recompute the denormalized counters from the recipient rows — never
 * incremented, so a crashed or partial mutation self-heals on the next one.
 * `opened`/`bounced` belong to a delivery phase and stay untouched.
 */
export async function refreshCampaignStats(
  conn: SqliteConn | PgConn,
  campaignId: string,
  now: Date
): Promise<{ totalRecipients: number; sent: number; replied: number }> {
  let stats: { total: number; sent: number; replied: number };
  if (conn.dialect === 'sqlite') {
    const r = conn.schema.campaignRecipients;
    const rows = await conn.db
      .select({
        total: sql<number>`count(*)`,
        sent: sql<number>`count(${r.sentAt})`,
        replied: sql<number>`count(${r.repliedAt})`,
      })
      .from(r)
      .where(eq(r.campaignId, campaignId));
    stats = {
      total: Number(rows[0]?.total ?? 0),
      sent: Number(rows[0]?.sent ?? 0),
      replied: Number(rows[0]?.replied ?? 0),
    };
  } else {
    const r = conn.schema.campaignRecipients;
    const rows = await conn.db
      .select({
        total: sql<number>`count(*)`,
        sent: sql<number>`count(${r.sentAt})`,
        replied: sql<number>`count(${r.repliedAt})`,
      })
      .from(r)
      .where(eq(r.campaignId, campaignId));
    stats = {
      total: Number(rows[0]?.total ?? 0),
      sent: Number(rows[0]?.sent ?? 0),
      replied: Number(rows[0]?.replied ?? 0),
    };
  }

  const updates = {
    totalRecipients: stats.total,
    sent: stats.sent,
    replied: stats.replied,
    updatedAt: now.toISOString(),
  };
  if (conn.dialect === 'sqlite') {
    await conn.db.update(conn.schema.campaigns).set(updates).where(eq(conn.schema.campaigns.id, campaignId));
  } else {
    await conn.db.update(conn.schema.campaigns).set(updates).where(eq(conn.schema.campaigns.id, campaignId));
  }
  return { totalRecipients: stats.total, sent: stats.sent, replied: stats.replied };
}
